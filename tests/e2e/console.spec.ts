import { test, expect } from "@playwright/test";
test("admin can inspect messages and Agent steps", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "工作台概览" })).toBeVisible();
  await page.screenshot({ path: ".local/overview.png", fullPage: true });
  await page
    .getByRole("button", { name: "群组与消息", exact: false })
    .first()
    .click();
  await page.locator(".group-list>button").first().click();
  await expect(page.getByRole("heading", { name: "消息时间线" })).toBeVisible();
  await expect(page.locator(".message-bubble").first()).toBeVisible();
  await page.getByRole("button", { name: "查看步骤" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Agent 运行详情", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".step-card").first()).toBeVisible();
  await page.screenshot({ path: ".local/agent.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("viewer cannot see write controls", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("viewer");
  await page.getByLabel("密码", { exact: true }).fill("viewer");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "工作台概览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建群组" })).toHaveCount(0);
  await page.getByRole("button", { name: "账号管理" }).click();
  await expect(page.getByRole("button", { name: "标记离线" })).toHaveCount(0);
});
