import { test, expect } from "@playwright/test";

for (const width of [320, 390, 768, 1440]) {
  test(`console fits ${width}px and keeps navigation and dialogs usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(page.getByRole("heading", { name: "工作台概览" })).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "新建群组" }).click();
    await expect(page.locator(".modal")).toBeVisible();
    await fits();
    const modal = await page.locator(".modal").boundingBox();
    expect(modal!.x).toBeGreaterThanOrEqual(0);
    expect(modal!.x + modal!.width).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "账号管理" }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await fits();
    if (width < 540) {
      const scroll = page.locator(".table-scroll");
      await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
    await page.getByRole("navigation").getByRole("button", { name: "群组与消息" }).click();
    const groups = page.locator(".group-list > button");
    for (let i = 0; i < await groups.count(); i++) {
      const loaded = page.waitForResponse(r => r.url().includes("/agent-runs") && r.request().method() === "GET");
      await groups.nth(i).click();
      if ((await (await loaded).json()).length) break;
    }
    await expect(page.getByRole("heading", { name: "消息时间线" })).toBeVisible();
    await fits();
    await expect(page.locator(".composer input")).toBeVisible();
    await page.getByRole("button", { name: "查看步骤" }).first().click();
    await expect(page.locator(".step-card").first()).toBeVisible();
    await fits();
    await page.getByRole("navigation").getByRole("button", { name: "定时序列" }).click();
    await expect(page.getByRole("heading", { name: "启动定时序列" })).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "预检所有步骤" }).click();
    await expect(page.locator(".modal.wide")).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "返回修改" }).click();
    await page.getByRole("button", { name: "新建模板" }).click();
    await expect(page.locator(".modal textarea")).toBeVisible();
    await fits();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.screenshot({ path: `.local/responsive-${width}.png`, fullPage: true });
  });
}
