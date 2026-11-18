import { expect, Locator, Page } from '@playwright/test';

export class CheckoutPage {
  private readonly page: Page;
  private readonly firstNameInput: Locator;
  private readonly lastNameInput: Locator;
  private readonly postalCodeInput: Locator;
  private readonly continueButton: Locator;
  private readonly finishButton: Locator;
  private readonly cancelButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.firstNameInput = this.page.locator('[data-test="firstName"]');
    this.lastNameInput = this.page.locator('[data-test="lastName"]');
    this.postalCodeInput = this.page.locator('[data-test="postalCode"]');
    this.continueButton = this.page.locator('[data-test="continue"]');
    this.finishButton = this.page.locator('[data-test="finish"]');
    this.cancelButton = this.page.locator('[data-test="cancel"]');
  }

  async assertOnYourInfoStep(): Promise<void> {
    await expect(this.page).toHaveURL(/\/checkout-step-one\.html$/);
    await expect(this.page.locator('[data-test="title"]')).toHaveText('Checkout: Your Information');
  }

  async fillYourInformation(firstName: string, lastName: string, postalCode: string): Promise<void> {
    await this.firstNameInput.fill(firstName);
    await this.lastNameInput.fill(lastName);
    await this.postalCodeInput.fill(postalCode);
  }

  async continueToOverview(): Promise<void> {
    await this.continueButton.click();
  }

  async assertOnOverviewStep(): Promise<void> {
    await expect(this.page).toHaveURL(/\/checkout-step-two\.html$/);
    await expect(this.page.locator('[data-test="title"]')).toHaveText('Checkout: Overview');
  }

  async assertSummaryValuesVisible(): Promise<void> {
    await expect(this.page.locator('[data-test="payment-info-value"]')).toBeVisible();
    await expect(this.page.locator('[data-test="shipping-info-value"]')).toBeVisible();
    await expect(this.page.locator('[data-test="subtotal-label"]')).toBeVisible();
    await expect(this.page.locator('[data-test="tax-label"]')).toBeVisible();
    await expect(this.page.locator('[data-test="total-label"]')).toBeVisible();
  }

  async finishCheckout(): Promise<void> {
    await this.finishButton.click();
  }

  async cancelCheckout(): Promise<void> {
    await this.cancelButton.click();
  }

  async assertOrderComplete(): Promise<void> {
    await expect(this.page).toHaveURL(/\/checkout-complete\.html$/);
    await expect(this.page.locator('[data-test="complete-header"]')).toHaveText('Thank you for your order!');
  }
}
