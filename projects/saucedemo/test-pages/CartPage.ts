import { expect, Locator, Page } from '@playwright/test';

export class CartPage {
  private readonly page: Page;
  private readonly cartItems: Locator;
  private readonly checkoutButton: Locator;
  private readonly continueShoppingButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.cartItems = this.page.locator('.cart_item');
    this.checkoutButton = this.page.locator('[data-test="checkout"]');
    this.continueShoppingButton = this.page.locator('[data-test="continue-shopping"]');
  }

  async assertOnCartPage(): Promise<void> {
    await expect(this.page).toHaveURL(/\/cart\.html$/);
    await expect(this.page.locator('[data-test="title"]')).toHaveText('Your Cart');
  }

  async assertItemPresent(productName: string): Promise<void> {
    await expect(this.page.locator('[data-test="inventory-item-name"]', { hasText: productName })).toBeVisible();
  }

  async assertItemCount(count: number | string): Promise<void> {
    await expect(this.cartItems).toHaveCount(Number(count));
  }

  async removeItem(productName: string): Promise<void> {
    await this.page
      .locator('.cart_item')
      .filter({ has: this.page.getByText(productName, { exact: true }) })
      .getByRole('button', { name: 'Remove' })
      .click();
  }

  async continueShopping(): Promise<void> {
    await this.continueShoppingButton.click();
  }

  async proceedToCheckout(): Promise<void> {
    await this.checkoutButton.click();
  }
}
