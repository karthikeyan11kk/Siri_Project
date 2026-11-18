/**
 * Action Mapper - Maps CSV actions to Page Object methods
 */

import { Page } from '@playwright/test';
import { PageObjectFactoryMap } from '../references/schema_types';
import { DataContext } from './data-loader';

export type PageObjectInstance = Record<string, unknown>;

export class ActionMapper {
  private pages: Map<string, PageObjectInstance> = new Map();
  private readonly pageFactories: PageObjectFactoryMap;
  private readonly dataContext: DataContext;

  constructor(page: Page, pageFactories: PageObjectFactoryMap, dataContext: DataContext) {
    this.pageFactories = pageFactories;
    this.dataContext = dataContext;
    this.rebindPage(page);
  }

  /**
   * Recreate page objects using the currently active Playwright page.
   */
  rebindPage(page: Page): void {
    this.pages.clear();
    for (const [pageName, createPage] of Object.entries(this.pageFactories)) {
      this.pages.set(pageName, createPage(page, this.dataContext) as PageObjectInstance);
    }
  }

  /**
   * Get a page object instance
   */
  getPageObject(pageName: string): PageObjectInstance {
    const page = this.pages.get(pageName);
    if (!page) {
      throw new Error(`Page object not found: ${pageName}`);
    }
    return page;
  }

  /**
   * Execute an action on a page object
   */
  async executeAction(pageName: string, methodName: string, ...params: string[]): Promise<unknown> {
    const pageObject = this.getPageObject(pageName);

    // Get the method from the page object
    const method = (pageObject as any)[methodName];

    if (!method) {
      throw new Error(`Method not found: ${pageName}.${methodName}`);
    }

    if (typeof method !== 'function') {
      throw new Error(`${methodName} is not a function on ${pageName}`);
    }

    // Call the method
    try {
      return await method.apply(pageObject, params);
    } catch (error) {
      throw new Error(`Action failed: ${pageName}.${methodName}(${params.join(', ')}) - ${error}`);
    }
  }

  /**
   * Get available methods on a page object
   */
  getAvailableMethods(pageName: string): string[] {
    const pageObject = this.getPageObject(pageName);
    const methods: string[] = [];

    // Get all public methods (not starting with _)
    for (const key in pageObject) {
      if (!key.startsWith('_') && typeof (pageObject as any)[key] === 'function') {
        methods.push(key);
      }
    }

    return methods;
  }

  /**
   * Check if a page object exists
   */
  pageExists(pageName: string): boolean {
    return this.pages.has(pageName);
  }

  /**
   * Get all available page objects
   */
  getAvailablePages(): string[] {
    return Array.from(this.pages.keys());
  }
}
