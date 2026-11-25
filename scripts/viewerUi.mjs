/** Open a secondary tool through the floating viewer menu. */
export async function openTool(page, selector, action = "click") {
  const menu = page.locator("#toolsMenu");
  if (!(await menu.isVisible())) await page.locator("#toolsToggle")[action]();
  await menu.locator(selector)[action]();
}
