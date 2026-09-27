// Optional SSH helper. Credentials come only from the invoking environment.
import { Client } from "ssh2";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createServer } from "node:net";
const root = resolve("."),
  target = process.env.SSH_DIRECTORY ?? "/project/groupflow-platform";
if (!process.env.SSH_HOST || !process.env.SSH_PASSWORD)
  throw new Error("Set SSH_HOST and SSH_PASSWORD.");
if (!/^\/[A-Za-z0-9_/-]+$/.test(target))
  throw new Error("Invalid deployment directory");
const conn = new Client();
await new Promise((ok, fail) =>
  conn
    .on("ready", ok)
    .on("error", fail)
    .connect({
      host: process.env.SSH_HOST,
      username: process.env.SSH_USER ?? "root",
      password: process.env.SSH_PASSWORD,
      readyTimeout: 20000,
    }),
);
function exec(command) {
  return new Promise((ok, fail) =>
    conn.exec(command, (e, s) => {
      if (e) return fail(e);
      s.on("data", (d) => process.stdout.write(d));
      s.stderr.on("data", (d) => process.stderr.write(d));
      s.on("close", (code) =>
        code === 0 ? ok() : fail(new Error("Remote exit " + code)),
      );
    }),
  );
}
const sftp = await new Promise((ok, fail) =>
  conn.sftp((e, s) => (e ? fail(e) : ok(s))),
);
const get = (path) =>
  new Promise((ok, fail) =>
    sftp.readFile(path, (e, b) => (e ? fail(e) : ok(b.toString()))),
  );
const dir = (path) => new Promise((ok) => sftp.mkdir(path, () => ok()));
try {
  const mode = process.argv[2];
  if (mode === "command") await exec(await readFile(process.argv[3], "utf8"));
  else if (mode === "upload" || mode === "deploy") {
    await dir(target);
    async function upload(path) {
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (
          [
            "node_modules",
            "dist",
            ".git",
            ".local",
            ".env",
            "backups",
            "test-results",
            "playwright-report",
          ].includes(item.name) ||
          item.name.endsWith(".env")
        )
          continue;
        const source = resolve(path, item.name),
          remote = target + "/" + relative(root, source).replaceAll("\\", "/");
        if (item.isDirectory()) {
          await dir(remote);
          await upload(source);
        } else
          await new Promise((ok, fail) =>
            sftp.fastPut(source, remote, (e) => (e ? fail(e) : ok())),
          );
      }
    }
    await upload(root);
    console.log("Project files uploaded.");
    if (mode === "deploy")
      await exec(
        `set -eu\ncd ${target}\nnpm ci\nnpm run typecheck\nnpm run build\nnpm run migrate\nsystemctl restart groupflow\nsystemctl is-active groupflow\n`,
      );
  } else if (mode === "tunnel") {
    const env = await get(target + "/.env"),
      match = env.match(/^DATABASE_URL=(.+)$/m);
    if (!match) throw new Error("DATABASE_URL missing");
    const url = new URL(match[1]),
      remotePort = Number(url.port || 5432);
    url.hostname = "127.0.0.1";
    url.port = "15433";
    await writeFile(
      ".env",
      `PORT=3000\nDATABASE_URL=${url}\nGATEWAY_URL=http://localhost:3100\nAGENT_URL=http://localhost:3200\nMOCK_SERVICES=true\n`,
    );
    const server = createServer((socket) =>
      conn.forwardOut(
        "127.0.0.1",
        socket.localPort ?? 0,
        "127.0.0.1",
        remotePort,
        (e, stream) => {
          if (e) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          socket.on("error", () => stream.destroy());
          stream.on("error", () => socket.destroy());
        },
      ),
    );
    server.listen(15433, "127.0.0.1", () =>
      console.log(
        "Database tunnel ready on localhost:15433; local .env written.",
      ),
    );
    await new Promise(() => {});
  } else throw new Error("Use upload, deploy, tunnel, or command <file>");
  conn.end();
} catch (e) {
  conn.end();
  throw e;
}
