/**
 * Screenshot utility - takes and attaches step screenshots to the Playwright report.
 * takeStepScreenshot is the main implementation. CSVTestRunner calls takeCsvStepScreenshot;
 * page-class methods call takeMethodStepScreenshot. Both wrappers forward to the main function.
 */

import { Locator, Page, test } from "@playwright/test";
import { TestStep } from "../runners/csv-parser";

export type StepScreenshotConfig = {
  mode: "off" | "all-steps";
  fullPage: boolean;
  highlight: boolean;
};

export function sanitizeAttachmentLabelPart(value: string): string {
  return (
    String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9-_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "step"
  );
}

// Tracks the currently executing CSV step, active page, and screenshot config so screenshots
// taken from within a page-class method (which only supply a description) can be attributed
// to the right step without the caller needing to pass page/config/step explicitly.
let activeStep: TestStep | undefined;
let activeStepIndex: number | string | undefined;
let activePage: Page | undefined;
let activeConfig: StepScreenshotConfig | undefined;

/** Records the CSV step currently executing; call at the start of each step. */
export function setActiveStepContext(step: TestStep, stepIndex: number | string): void {
  activeStep = step;
  activeStepIndex = stepIndex;
}

/** Records the current page and screenshot config; call on construction and whenever the active page changes. */
export function setActiveScreenshotContext(page: Page, config: StepScreenshotConfig): void {
  activePage = page;
  activeConfig = config;
}

/**
 * Takes a screenshot (optionally highlighting a locator first) and attaches it to the test report.
 * No-ops when config.mode is 'off'. This is the main implementation; call takeCsvStepScreenshot or
 * takeMethodStepScreenshot instead of this directly.
 * @param page - Page to capture.
 * @param config - Screenshot behavior configuration.
 * @param step - The CSV step this screenshot belongs to (used to build the file name).
 * @param stepIndex - Step number/label used to build the file name.
 * @param preResolvedLocator - Optional locator to highlight before capturing.
 * @param methodStepDescription - When set (screenshot taken from within a page-class method),
 * appended to the file name: step-<num>-<action>-<page-object>-<description>.webp.
 */
export async function takeStepScreenshot(
  page: Page,
  config: StepScreenshotConfig,
  step: TestStep,
  stepIndex: number | string,
  preResolvedLocator?: Locator,
  methodStepDescription?: string,
): Promise<void> {
  if (config.mode !== "all-steps") {
    return;
  }

  try {
    const stepNum = String(stepIndex).padStart(3, "0");
    const actionPart = sanitizeAttachmentLabelPart(step.action || "action");
    const pagePart = sanitizeAttachmentLabelPart(step.page || "");
    const objectPart = sanitizeAttachmentLabelPart(step.object || "");
    const targetPart = [pagePart, objectPart].filter(Boolean).join("-");
    const methodDescriptionPart = methodStepDescription
      ? sanitizeAttachmentLabelPart(methodStepDescription)
      : "";
    const namePartsAfterStep = [actionPart, targetPart, methodDescriptionPart].filter(Boolean);
    const attachmentName = `step-${stepNum}-${namePartsAfterStep.join("-")}.webp`;
    let boundingBoxHighlightApplied = false;
    let playwrightHighlightLocator: Locator | undefined;

    // Attempt to highlight the target element before screenshotting
    if (config.highlight && preResolvedLocator) {
      try {
        try {
          await preResolvedLocator
            .visible()
            .first()
            .evaluate((el) => {
              try {
                el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as any });
              } catch {
                el.scrollIntoView();
              }
            });
        } catch {
          await preResolvedLocator.visible().first().scrollIntoViewIfNeeded();
        }

        // If the count of visible locators is more than 1 use bounding boxhighlight else use playwright locator highlight
        if (await preResolvedLocator.visible().count() > 1) {
          await applyBoundingBoxHighlight(preResolvedLocator);
          boundingBoxHighlightApplied = true;
        }
        else {
          playwrightHighlightLocator = preResolvedLocator;
          await applyPlaywrightLocatorHighlight(playwrightHighlightLocator);
        }
        
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`${stepNum}: Highlight failed because of: ${message}`);
      }
    }

    try {
      const body = await page.screenshot({
        type: "webp",
        quality: 50,
        fullPage: config.fullPage,
        animations: "disabled",
        caret: "hide",
      });

      // Attach the screenshot to the test report
      await test.info().attach(attachmentName, { body, contentType: "image/webp" });
    } finally {
      if (boundingBoxHighlightApplied) {
        await removeBoundingBoxHighlight(page);
      } else if (playwrightHighlightLocator) {
        await removePlaywrightLocatorHighlight(playwrightHighlightLocator);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to attach pre-action screenshot at step ${stepIndex}: ${message}`);
  }
}

/**
 * CSVTestRunner-facing entry point: forwards directly to takeStepScreenshot with no description.
 * @param page - Page to capture.
 * @param config - Screenshot behavior configuration.
 * @param step - The CSV step this screenshot belongs to.
 * @param stepIndex - Step number/label used to build the file name.
 * @param preResolvedLocator - Optional locator to highlight before capturing.
 */
export async function takeCsvStepScreenshot(
  page: Page,
  config: StepScreenshotConfig,
  step: TestStep,
  stepIndex: number | string,
  preResolvedLocator?: Locator,
): Promise<void> {
  await takeStepScreenshot(page, config, step, stepIndex, preResolvedLocator);
}

/**
 * Page-class-facing entry point: call with just a description and an optional locator.
 * Page, screenshot config, and the current step/stepIndex are all resolved from runtime
 * context (see setActiveScreenshotContext and setActiveStepContext).
 * @param methodStepDescription - Label appended to the file name: step-<num>-<action>-<page-object>-<description>.webp.
 * @param preResolvedLocator - Optional locator to highlight before capturing.
 */
export async function takeMethodStepScreenshot(
  methodStepDescription: string,
  preResolvedLocator?: Locator,
): Promise<void> {
  if (!activePage || !activeConfig || !activeStep || activeStepIndex === undefined) {
    return;
  }
  await takeStepScreenshot(
    activePage,
    activeConfig,
    activeStep,
    activeStepIndex,
    preResolvedLocator,
    methodStepDescription,
  );
}

/**
 * Highlight locator using playwright locator.highlight() function
 * @param locator - The locator to highlight before capturing.
 */
export async function applyPlaywrightLocatorHighlight(preResolvedLocator: Locator): Promise<void> {
  await preResolvedLocator.visible().highlight({
    style: {
      backgroundColor: "transparent !important",
      outline: "3px solid #ff0037b0",
      padding: "4px",
    },
  });
}

/**
 * Remove the highlight from a locator using playwright locator.hideHighlight() function.
 * @param preResolvedLocator - The locator to remove the highlight from.
 */
export async function removePlaywrightLocatorHighlight(preResolvedLocator: Locator): Promise<void> {
  await preResolvedLocator.visible().hideHighlight();
}

/**
 * Highlight locator using bounding box
 * @param locator - The locator to highlight using its bounding box.
 */
export async function applyBoundingBoxHighlight(preResolvedLocator: Locator): Promise<void> {
  await test.step("Add highlight to the locators", async () => {
    const visibleLocators = preResolvedLocator.visible();
    await visibleLocators.evaluateAll((elements) => {
      const d = document;
      const pad = 4;

      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          continue;
        }

        const left = Math.max(0, rect.left - pad);
        const top = Math.max(0, rect.top - pad);
        const right = Math.min(window.innerWidth, rect.right + pad);
        const bottom = Math.min(window.innerHeight, rect.bottom + pad);
        const overlay = d.createElement("div");
        overlay.dataset.pwCsvHighlight = "bounding-box";
        overlay.style.cssText = [
          "position:fixed",
          `left:${left}px`,
          `top:${top}px`,
          `width:${right - left}px`,
          `height:${bottom - top}px`,
          "border:3px solid #ff0037b0",
          "padding:4px",
          "box-sizing:border-box",
          "pointer-events:none",
          "z-index:2147483647",
          "background:transparent",
        ].join(";");
        d.documentElement.appendChild(overlay);
      }
    });
  });
}
/**
 * Remove all bounding-box highlight overlays from the page.
 * @param page - The page containing the bounding-box highlight overlays.
 */
export async function removeBoundingBoxHighlight(page: Page): Promise<void> {
  await test.step("Remove highlight to the locators", async () => {
    await page
    .evaluate(() => {
      document
        .querySelectorAll('[data-pw-csv-highlight="bounding-box"]')
        .forEach((element) => element.remove());
    })
    .catch(() => undefined);
  });
}
