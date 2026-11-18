import { expect, Locator, Page } from '@playwright/test';

export class HeaderMenu {
  private readonly page: Page;
  private readonly burgerButton: Locator;
  private readonly closeButton: Locator;
  private readonly menuPanel: Locator;
  private readonly allItemsLink: Locator;
  private readonly aboutLink: Locator;
  private readonly logoutLink: Locator;
  private readonly resetAppStateLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.burgerButton = this.page.locator('#react-burger-menu-btn');
    this.closeButton = this.page.locator('#react-burger-cross-btn');
    this.menuPanel = this.page.locator('.bm-menu-wrap');
    this.allItemsLink = this.page.locator('[data-test="inventory-sidebar-link"]');
    this.aboutLink = this.page.locator('[data-test="about-sidebar-link"]');
    this.logoutLink = this.page.locator('[data-test="logout-sidebar-link"]');
    this.resetAppStateLink = this.page.locator('[data-test="reset-sidebar-link"]');
  }

  async openMenu(): Promise<void> {
    await this.burgerButton.click();
    await expect(this.menuPanel).toBeVisible();
  }

  async closeMenu(): Promise<void> {
    await this.closeButton.click();
    await expect(this.menuPanel).not.toBeVisible();
  }

  async clickAllItems(): Promise<void> {
    await this.allItemsLink.click();
  }

  async clickAbout(): Promise<void> {
    await this.aboutLink.click();
  }

  async clickLogout(): Promise<void> {
    await this.logoutLink.click();
  }

  async clickResetAppState(): Promise<void> {
    await this.resetAppStateLink.click();
  }
}
