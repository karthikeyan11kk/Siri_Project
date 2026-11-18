import * as path from 'path';
import { FrameworkProjectConfig } from '../../../framework/references/schema_types';
import { LoginPage } from '../test-pages/LoginPage';
import { InventoryPage } from '../test-pages/InventoryPage';
import { CartPage } from '../test-pages/CartPage';
import { CheckoutPage } from '../test-pages/CheckoutPage';
import { HeaderMenu } from '../test-pages/HeaderMenu';

export const sauceDemoProject: FrameworkProjectConfig = {
  name: 'saucedemo',
  displayName: 'SauceDemo',
  baseURL: 'https://www.saucedemo.com',
  testsRootDir: path.resolve(__dirname, '../test-scripts'),
  testDataRootDir: path.resolve(__dirname, '../test-data'),
  testFlowsRootDir: path.resolve(__dirname, '../test-flows'),
  testCyclesRootDir: path.resolve(__dirname, '../test-cycles'),
  pageFactories: {
    LoginPage: (page) => new LoginPage(page),
    InventoryPage: (page) => new InventoryPage(page),
    CartPage: (page) => new CartPage(page),
    CheckoutPage: (page) => new CheckoutPage(page),
    HeaderMenu: (page) => new HeaderMenu(page),
  },
};
