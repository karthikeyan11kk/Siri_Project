/**
 * Page object emitter - generates TypeScript page class files
 */

import * as fs from 'fs';
import * as path from 'path';
import { PageClass } from '../core/types';

export class PageObjectEmitter {
  private static formatSectionComments(raw: string | undefined, indent = '  '): string[] {
    if (!raw?.trim()) {
      return [];
    }
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t) {
        out.push(`${indent}${t}`);
      }
    }
    return out;
  }

  private static toFramePropertyName(frameSelector: string): string {
    const idMatch = frameSelector.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/);
    const candidate = (idMatch?.[1] || frameSelector)
      .replace(/^panel-body\d+-/i, '')
      .replace(/^panel/i, '')
      .replace(/iframe$/i, '')
      .replace(/frame$/i, '')
      .replace(/page$/i, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim();

    const camel = candidate
      .split(/\s+/)
      .filter(Boolean)
      .map((part, idx) => {
        const lower = part.toLowerCase();
        return idx === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join('');

    const safeBase = camel && /^[a-zA-Z_]/.test(camel) ? camel : 'frame';
    return `${safeBase}Frame`;
  }

  private static buildFrameAliases(pageClass: PageClass): Map<string, string> {
    const aliases = new Map<string, string>();
    const used = new Set<string>();

    for (const [, obj] of pageClass.objects) {
      const parsed = this.parseSemanticSelector(obj.selector);
      const frameSelector = parsed.frameSelector;
      if (!frameSelector || aliases.has(frameSelector)) {
        continue;
      }

      const baseAlias = this.toFramePropertyName(frameSelector);
      let alias = baseAlias;
      let suffix = 2;
      while (used.has(alias)) {
        alias = `${baseAlias}${suffix}`;
        suffix++;
      }

      aliases.set(frameSelector, alias);
      used.add(alias);
    }

    return aliases;
  }

  public static ensureFrameAlias(
    frameSelector: string,
    aliases: Map<string, string>,
    usedAliases: Set<string>
  ): string {
    const existing = aliases.get(frameSelector);
    if (existing) {
      return existing;
    }

    const baseAlias = this.toFramePropertyName(frameSelector);
    let alias = baseAlias;
    let suffix = 2;
    while (usedAliases.has(alias)) {
      alias = `${baseAlias}${suffix}`;
      suffix++;
    }

    aliases.set(frameSelector, alias);
    usedAliases.add(alias);
    return alias;
  }

  private static parseSemanticSelector(selector: string): {
    frameSelector?: string;
    nthIndex?: number;
    kind: 'role' | 'text' | 'locator';
    role?: string;
    name?: string;
    value: string;
  } {
    const framePrefix = 'frame=';
    let frameSelector: string | undefined;
    let innerSelector = selector;
    let nthIndex: number | undefined;

    if (selector.startsWith(framePrefix)) {
      const frameSeparator = selector.indexOf('>>', framePrefix.length);
      if (frameSeparator > -1) {
        frameSelector = selector.slice(framePrefix.length, frameSeparator);
        innerSelector = selector.slice(frameSeparator + 2);
      }
    }

    const nthMatch = innerSelector.match(/\|nth=(\d+)$/);
    if (nthMatch) {
      nthIndex = Number(nthMatch[1]);
      innerSelector = innerSelector.slice(0, nthMatch.index);
    }

    const roleMatch = innerSelector.match(/^role=([^\[]+)\[name="([^"]+)"\]$/);
    if (roleMatch) {
      return {
        frameSelector,
        nthIndex,
        kind: 'role',
        role: roleMatch[1],
        name: roleMatch[2],
        value: innerSelector,
      };
    }

    const textMatch = innerSelector.match(/^text=(.+)$/);
    if (textMatch) {
      return {
        frameSelector,
        nthIndex,
        kind: 'text',
        value: textMatch[1],
      };
    }

    return {
      frameSelector,
      nthIndex,
      kind: 'locator',
      value: innerSelector,
    };
  }

  /**
   * Generate TypeScript page class file content
   */
  static generatePageClass(pageClass: PageClass): string {
    const frameAliases = this.buildFrameAliases(pageClass);
    const importTypes = ['expect', 'Locator', 'Page'];
    if (frameAliases.size > 0) {
      importTypes.splice(1, 0, 'FrameLocator');
    }
    const imports = `import { ${importTypes.join(', ')} } from '@playwright/test';\n`;

    const classBody = this.generateClassBody(pageClass, frameAliases);

    return `${imports}\nexport class ${pageClass.name} {\n${classBody}\n}\n`;
  }

  /**
   * Write page class file to disk
   */
  static writePageClass(pageClass: PageClass, dryRun: boolean = false): void {
    const content = this.generatePageClass(pageClass);
    const dir = path.dirname(pageClass.filePath);

    if (!dryRun) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(pageClass.filePath, content, 'utf-8');
    }
  }

  /**
   * Generate class body with private members and constructor
   */
  private static generateClassBody(pageClass: PageClass, frameAliases: Map<string, string>): string {
    const lines: string[] = [];

    // Private page member
    lines.push('  private readonly page: Page;');

    if (frameAliases.size > 0) {
      for (const [, alias] of frameAliases) {
        lines.push(`  private readonly ${alias}: FrameLocator;`);
      }
    }

    lines.push('');

    // Private locator members
    for (const [, obj] of pageClass.objects) {
      if (!obj.isMethod) {
        lines.push(...this.formatSectionComments(obj.leadingSectionComment));
        lines.push(`  private readonly ${obj.name}: Locator;`);
      }
    }
    lines.push('');

    // Constructor
    lines.push('  constructor(page: Page) {');
    lines.push('    this.page = page;');
    for (const [frameSelector, alias] of frameAliases) {
      lines.push(`    this.${alias} = this.page.frameLocator('${frameSelector.replace(/'/g, "\\'")}');`);
    }
    for (const [, obj] of pageClass.objects) {
      if (!obj.isMethod) {
        lines.push(...this.formatSectionComments(obj.leadingSectionComment, '    '));
        lines.push(`    this.${obj.name} = ${this.buildLocatorExpression(obj.selector, frameAliases)};`);
      }
    }
    lines.push('  }');

    return lines.join('\n');
  }

  /**
   * Append new objects to existing page class without duplicates
   */
  static mergePageClass(existingContent: string, newPageClass: PageClass): string {
    // Simple regex-based merge for now - can be enhanced with ts-morph
    const lines = existingContent.split('\n');
    const constructorEndIdx = lines.findIndex((line) => line.includes('this.page = page;'));

    if (constructorEndIdx === -1) {
      return existingContent; // Couldn't find constructor
    }

    const newObjects: string[] = [];
    const newMembers: string[] = [];

    for (const [, obj] of newPageClass.objects) {
      if (!obj.isMethod) {
        newMembers.push(...this.formatSectionComments(obj.leadingSectionComment));
        newMembers.push(`  private readonly ${obj.name}: Locator;`);
        newObjects.push(...this.formatSectionComments(obj.leadingSectionComment, '    '));
        newObjects.push(`    this.${obj.name} = ${this.buildLocatorExpression(obj.selector)};`);
      }
    }

    // Insert members before constructor
    const insertMemberIdx = lines.findIndex((line) => line.includes('constructor('));

    // Insert into constructor
    const constructorCloseIdx = lines.findIndex((line, idx) => idx > constructorEndIdx && line.includes('}'));

    if (insertMemberIdx > -1 && constructorCloseIdx > -1) {
      lines.splice(insertMemberIdx, 0, ...newMembers, '');
      lines.splice(constructorCloseIdx, 0, ...newObjects);
    }

    return lines.join('\n');
  }

  public static buildLocatorExpression(selector: string, frameAliases?: Map<string, string>): string {
    const parsed = this.parseSemanticSelector(selector);
    const root = parsed.frameSelector
      ? (() => {
          const alias = frameAliases?.get(parsed.frameSelector);
          if (alias) {
            return `this.${alias}`;
          }
          return `this.page.frameLocator('${parsed.frameSelector.replace(/'/g, "\\'")}')`;
        })()
      : 'this.page';
    const nthSuffix =
      typeof parsed.nthIndex === 'number' && Number.isInteger(parsed.nthIndex)
        ? `.nth(${parsed.nthIndex})`
        : '';

    if (parsed.kind === 'role' && parsed.role && parsed.name !== undefined) {
      return `${root}.getByRole('${parsed.role.replace(/'/g, "\\'")}', { name: '${parsed.name.replace(/'/g, "\\'")}' })${nthSuffix}`;
    }

    if (parsed.kind === 'text') {
      return `${root}.getByText('${parsed.value.replace(/'/g, "\\'")}')${nthSuffix}`;
    }

    return `${root}.locator('${parsed.value.replace(/'/g, "\\'")}')${nthSuffix}`;
  }
}
