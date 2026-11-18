/**
 * Page object manager - handles deduplication and merging with existing page classes
 */

import * as fs from 'fs';
import * as path from 'path';
import { PageClass, PageObject, DedupeResult } from './types';

export class PageObjectManager {
  /**
   * Load existing page class from TypeScript file if it exists
   */
  static loadExistingPageClass(filePath: string): PageClass | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const className = path.basename(filePath, '.ts');

    // Extract object assignments from constructor lines.
    const locatorAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.locator\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;
    const frameLocatorAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.frameLocator\(['"]([^'"]+)['"]\)\.locator\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;
    const roleAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.getByRole\(['"]([^'"]+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\)(?:\.nth\((\d+)\))?/g;
    const textAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.getByText\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;
    const frameRoleAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.frameLocator\(['"]([^'"]+)['"]\)\.getByRole\(['"]([^'"]+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\)(?:\.nth\((\d+)\))?/g;
    const frameTextAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.frameLocator\(['"]([^'"]+)['"]\)\.getByText\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;
    const frameAliasAssignmentRegex = /this\.(\w+)\s*=\s*this\.page\.frameLocator\(['"]([^'"]+)['"]\)/g;
    const aliasLocatorAssignmentRegex = /this\.(\w+)\s*=\s*this\.(\w+)\.locator\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;
    const aliasRoleAssignmentRegex = /this\.(\w+)\s*=\s*this\.(\w+)\.getByRole\(['"]([^'"]+)['"],\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\)(?:\.nth\((\d+)\))?/g;
    const aliasTextAssignmentRegex = /this\.(\w+)\s*=\s*this\.(\w+)\.getByText\(['"]([^'"]+)['"]\)(?:\.nth\((\d+)\))?/g;

    const pageClass: PageClass = {
      name: className,
      filePath,
      objects: new Map(),
      methods: new Map(),
    };

    const frameAliases = new Map<string, string>();
    let aliasMatch;
    while ((aliasMatch = frameAliasAssignmentRegex.exec(content)) !== null) {
      const [, aliasName, frameSelector] = aliasMatch;
      frameAliases.set(aliasName, frameSelector.replace(/\\"/g, '"').replace(/\\'/g, "'"));
    }

    let match;
    while ((match = locatorAssignmentRegex.exec(content)) !== null) {
      const [, objectName, selector, nthIndex] = match;
      const normalizedSelector = selector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${normalizedSelector}|nth=${nthIndex}` : normalizedSelector,
        isMethod: false,
      });
    }

    while ((match = frameLocatorAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameSelector, innerSelector, nthIndex] = match;
      const normalizedFrame = frameSelector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedInner = innerSelector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${normalizedFrame}>>${normalizedInner}`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    while ((match = roleAssignmentRegex.exec(content)) !== null) {
      const [, objectName, role, name, nthIndex] = match;
      const normalizedRole = role.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedName = name.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const roleSelector = `role=${normalizedRole}[name="${normalizedName}"]`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${roleSelector}|nth=${nthIndex}` : roleSelector,
        isMethod: false,
      });
    }

    while ((match = textAssignmentRegex.exec(content)) !== null) {
      const [, objectName, text, nthIndex] = match;
      const textSelector = `text=${text.replace(/\\"/g, '"').replace(/\\'/g, "'")}`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${textSelector}|nth=${nthIndex}` : textSelector,
        isMethod: false,
      });
    }

    while ((match = frameRoleAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameSelector, role, name, nthIndex] = match;
      const normalizedFrame = frameSelector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedRole = role.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedName = name.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${normalizedFrame}>>role=${normalizedRole}[name="${normalizedName}"]`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    while ((match = frameTextAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameSelector, text, nthIndex] = match;
      const normalizedFrame = frameSelector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedText = text.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${normalizedFrame}>>text=${normalizedText}`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    while ((match = aliasLocatorAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameAlias, innerSelector, nthIndex] = match;
      const frameSelector = frameAliases.get(frameAlias);
      if (!frameSelector) {
        continue;
      }
      const normalizedInner = innerSelector.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${frameSelector}>>${normalizedInner}`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    while ((match = aliasRoleAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameAlias, role, name, nthIndex] = match;
      const frameSelector = frameAliases.get(frameAlias);
      if (!frameSelector) {
        continue;
      }
      const normalizedRole = role.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const normalizedName = name.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${frameSelector}>>role=${normalizedRole}[name="${normalizedName}"]`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    while ((match = aliasTextAssignmentRegex.exec(content)) !== null) {
      const [, objectName, frameAlias, text, nthIndex] = match;
      const frameSelector = frameAliases.get(frameAlias);
      if (!frameSelector) {
        continue;
      }
      const normalizedText = text.replace(/\\"/g, '"').replace(/\\'/g, "'");
      const combined = `frame=${frameSelector}>>text=${normalizedText}`;
      pageClass.objects.set(objectName, {
        name: objectName,
        selector: nthIndex ? `${combined}|nth=${nthIndex}` : combined,
        isMethod: false,
      });
    }

    return pageClass;
  }

  /**
   * Merge new page objects into existing page class, handling deduplication
   */
  static mergePageObjects(
    existing: PageClass,
    newObjects: Map<string, PageObject>,
    strategy: 'reuse' | 'rename' | 'skip' = 'reuse'
  ): DedupeResult {
    const result: DedupeResult = {
      added: [],
      reused: [],
      skipped: [],
      conflicts: [],
    };

    for (const [newName, newObject] of newObjects) {
      const normalized = this.normalizeSelector(newObject.selector);

      // Check if exact selector already exists
      let foundExisting = false;
      for (const [existingName, existingObject] of existing.objects) {
        const existingNormalized = this.normalizeSelector(existingObject.selector);
        if (existingNormalized === normalized) {
          result.reused.push(existingName);
          foundExisting = true;
          break;
        }
      }

      if (foundExisting) {
        continue;
      }

      // Check if object name already exists with different selector
      if (existing.objects.has(newName)) {
        const existingSelector = this.normalizeSelector(existing.objects.get(newName)!.selector);
        if (existingSelector !== normalized) {
          if (strategy === 'skip') {
            result.skipped.push(newName);
            result.conflicts.push({
              name: newName,
              reason: `Selector mismatch: existing uses "${existing.objects.get(newName)!.selector}"`,
            });
          } else if (strategy === 'rename') {
            const renamedName = this.generateUniqueName(newName, existing.objects);
            existing.objects.set(renamedName, { ...newObject, name: renamedName });
            result.added.push(renamedName);
          } else {
            // In reuse mode, keep the object name stable but refresh the selector.
            existing.objects.set(newName, { ...newObject, name: newName });
            result.added.push(newName);
          }
        }
        continue;
      }

      // Safe to add
      existing.objects.set(newName, newObject);
      result.added.push(newName);
    }

    return result;
  }

  /**
   * Normalize selector for comparison (removes whitespace, normalizes quotes)
   */
  private static normalizeSelector(selector: string): string {
    return selector
      .replace(/\s+/g, ' ')
      .replace(/['"]/g, '"')
      .toLowerCase()
      .trim();
  }

  /**
   * Generate unique name by appending suffix
   */
  private static generateUniqueName(baseName: string, existing: Map<string, PageObject>): string {
    let counter = 2;
    let candidate = `${baseName}${counter}`;
    while (existing.has(candidate)) {
      counter++;
      candidate = `${baseName}${counter}`;
    }
    return candidate;
  }
}
