import { expect, Locator, Page } from '@playwright/test';

export class InventoryPage {
  private readonly page: Page;
  private readonly title: Locator;
  private readonly inventoryItems: Locator;
  private readonly sortDropdown: Locator;
  private readonly shoppingCartBadge: Locator;
  private readonly shoppingCartLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.title = this.page.locator('[data-test="title"]');
    this.inventoryItems = this.page.locator('[data-test="inventory-item"]');
    this.sortDropdown = this.page.locator('[data-test="product-sort-container"]');
    this.shoppingCartBadge = this.page.locator('[data-test="shopping-cart-badge"]');
    this.shoppingCartLink = this.page.locator('[data-test="shopping-cart-link"]');
  }

  productName(name: string) {
    return this.page.locator('[data-test="inventory-item-name"]', { hasText: name });
  }

  addToCartButtonByProductName(name: string) {
    return this.page
      .locator('[data-test="inventory-item"]')
      .filter({ has: this.page.getByText(name, { exact: true }) })
      .locator('button');
  }

  removeButtonByProductName(name: string) {
    return this.page
      .locator('[data-test="inventory-item"]')
      .filter({ has: this.page.getByText(name, { exact: true }) })
      .getByRole('button', { name: 'Remove' });
  }

  async assertOnInventoryPage(): Promise<void> {
    await expect(this.page).toHaveURL(/\/inventory\.html$/);
    await expect(this.title).toHaveText('Products');
  }

  async assertInventoryCountAtLeast(min: number | string): Promise<void> {
    const count = await this.inventoryItems.count();
    expect(count).toBeGreaterThanOrEqual(Number(min));
  }

  async addProductToCart(name: string): Promise<void> {
    await this.addToCartButtonByProductName(name).click();
  }

  async removeProductFromCart(name: string): Promise<void> {
    await this.removeButtonByProductName(name).click();
  }

  async openCart(): Promise<void> {
    await this.shoppingCartLink.click();
  }

  async assertCartBadgeCount(count: number | string): Promise<void> {
    await expect(this.shoppingCartBadge).toHaveText(String(count));
  }

  async assertCartBadgeHidden(): Promise<void> {
    await expect(this.shoppingCartBadge).toHaveCount(0);
  }

  async sortBy(optionLabel: 'Name (A to Z)' | 'Name (Z to A)' | 'Price (low to high)' | 'Price (high to low)'): Promise<void> {
    await this.sortDropdown.selectOption({ label: optionLabel });
  }

  async getVisibleProductNames(): Promise<string[]> {
    return this.page.locator('[data-test="inventory-item-name"]').allTextContents();
  }

  async getVisibleProductPrices(): Promise<number[]> {
    const prices = await this.page.locator('[data-test="inventory-item-price"]').allTextContents();
    return prices.map((p) => Number(p.replace('$', '').trim()));
  }

  async assertSortedByPriceLowToHigh(): Promise<void> {
    const prices = await this.getVisibleProductPrices();
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  }

  async assertSortedByNameDescending(): Promise<void> {
    const productNames = await this.getVisibleProductNames();
    const sorted = [...productNames].sort((a, b) => b.localeCompare(a));
    expect(productNames).toEqual(sorted);
  }
}
