# Test Script Migrations

Convert Playwright recorded scripts and other test formats to page objects + CSV test scripts compatible with your CSV framework.

## Architecture

```
migrations/
├── core/                          # Shared types and logic
│   ├── types.ts                   # Core migration types
│   ├── page-object-manager.ts     # Deduplication and merging
│   └── orchestrator.ts            # Main pipeline
├── adapters/                      # Input format parsers
│   └── playwright/
│       └── spec-parser.ts         # Playwright spec parser
├── emitters/                      # Output generators
│   ├── page-object-emitter.ts     # TypeScript page class generator
│   └── csv-script-emitter.ts      # CSV test script generator
├── cli/                           # Command-line interfaces
│   └── migrate-playwright.ts      # Playwright migration CLI
└── index.ts                       # Public API
```

## Features

- **Deduplication**: Avoids adding duplicate objects to page classes
- **Merge strategies**: Choose how to handle conflicts (reuse, rename, skip)
- **Dry-run mode**: Preview changes without writing files
- **Extensible**: Add new adapters (MABL, Excel, text) by implementing the same pipeline
- **STRICT Column Contracts**: Generated CSV scripts automatically apply STRICT format transformations (May 2026+)

## STRICT Column Contract Alignment (May 2026+)

All generated CSV scripts are automatically transformed to comply with STRICT column contracts enforced by the CSV runner:

### Automatic Transformations

| Action | Migration Output | STRICT Format |
|--------|------------------|---------------|
| **FILL/SELECT with params** | `Condition=params, Data=value` | Same (correct) |
| **CLICK with params** | Moves params to Condition if needed | `Condition=params` |
| **CLICK_TO_SWITCH** | Moves timeout from Condition to Data | `Data=timeout` |
| **SWITCH_CONTEXT** | Moves timeout from Condition to Data | `Data=timeout` |
| **ASSERT/SOFTASSERT** | State in Condition, timeout in Data | `Condition=state, Data=timeout` |

### Column Contract Rules

- **Dynamic params** → Condition column ONLY (e.g., `FILL,Page,field,param1|param2,value`)
- **Timeout values** → Data column ONLY (e.g., `CLICK_TO_SWITCH,Page,button,,5000`)
- **ASSERT state** → Condition column ONLY, must not be empty (e.g., `ASSERT,Page,button,is visible,`)
- **No fallback logic** → STRICT enforcement means old CSV formats will fail if not migrated

### Example Generated CSV (STRICT)

```csv
Run,Step,Action,Page,Object,Condition,Data
Y,1,GOTO,page,page,,https://example.com
Y,2,FILL,LoginPage,usernameInput,,john_doe
Y,3,FILL,LoginPage,passwordInput,123,secret_sauce
Y,4,CLICK,LoginPage,loginButton,,
Y,5,ASSERT,LoginPage,welcomeMessage,is visible,
Y,6,CLICK_TO_SWITCH,HomePage,notificationLink,,5000
Y,7,SWITCH_CONTEXT,page,page,,3000
Y,8,ASSERT,NotificationPage,title,is visible,10000
```

Generated CSV scripts are **immediately compatible** with the STRICT CSV runner without manual format changes.

## Quick Start

### Convert Playwright Recorded Script

```bash
npm run migrate:playwright -- src/recorded-test.spec.ts --project=saucedemo
```

Generated files:
- Page classes updated under `src/projects/saucedemo/pages/`
- CSV script written to `src/projects/saucedemo/test-scripts/generated/`

### Options

```bash
# Dry-run mode (preview without writing)
npm run migrate:playwright -- src/recorded-test.spec.ts --project=saucedemo --dry-run

# Specify project
npm run migrate:playwright -- src/recorded-test.spec.ts --project=s360

# Custom merge strategy
npm run migrate:playwright -- src/recorded-test.spec.ts --project=s360 --strategy=rename

# Custom script name
npm run migrate:playwright -- src/recorded-test.spec.ts --project=s360 --script-name=tc_custom_flow
```

## Merge Strategies

- **reuse** (default): Reuse existing object names when selectors match
- **rename**: Rename conflicting objects with suffix (e.g., `loginButton2`)
- **skip**: Skip objects that would conflict

## Programmatic Usage

```typescript
import { MigrationOrchestrator } from './src/migrations';

const report = await MigrationOrchestrator.migratePlaywrightSpec(
  'src/recorded-test.spec.ts',
  {
    projectName: 'saucedemo',
    mergeStrategy: 'reuse',
    dryRun: false,
  }
);

console.log(report);
```

## Types

### MigrationModel

Central data structure:

```typescript
interface MigrationModel {
  projectName: string;           // e.g., 'saucedemo'
  scriptName: string;            // e.g., 'tc_recorded_flow'
  pages: Map<string, PageClass>; // One entry per page object
  testScript: TestScript;        // Generated test actions
}
```

### PageClass

```typescript
interface PageClass {
  name: string;                    // Page class name
  filePath: string;                // Output file path
  objects: Map<string, PageObject>; // DOM locators
  methods: Map<string, PageObject>; // Parameterized locators
}
```

### TestAction

```typescript
interface TestAction {
  action: string;         // GOTO, CLICK, FILL, ASSERT_URL_CONTAINS, etc.
  page?: string;         // Page class name
  object?: string;       // Object name or 'page' for page root
  data?: string;         // Value to fill, path to navigate, or assertion text
  condition?: string;    // Optional condition
  description?: string;  // Source description
}
```

## Future Adapters

To add support for other formats:

1. Create new adapter parser (e.g., `adapters/mabl/manifest-parser.ts`)
2. Implement parser following same interface: `parseSource() → MigrationModel`
3. Create new CLI (e.g., `cli/migrate-mabl.ts`)
4. Register in package.json scripts

### Example: Adding MABL Support

```typescript
// adapters/mabl/manifest-parser.ts
export class MABLManifestParser {
  static parseManifest(filePath: string, projectName: string): MigrationModel {
    // Parse MABL export format
    // Extract actions and page objects
    // Return MigrationModel
  }
}
```

Then add to `package.json`:

```json
{
  "scripts": {
    "migrate:mabl": "ts-node src/migrations/cli/migrate-mabl.ts"
  }
}
```

## Limitations

- Playwright parser uses regex-based extraction, handles common patterns but may miss edge cases
- Complex nested locators might not parse correctly
- Dynamic/runtime selectors need manual adjustment
- Page assignment is inferred; manual tweaking may be needed

## Troubleshooting

**Q: Objects not detected from my spec?**  
A: Add descriptions/comments in your spec. The parser looks for `data-test`, `name`, or CSS classes as clues.

**Q: Duplicate selector creates new object instead of reusing?**  
A: Check selector formatting—whitespace and quote style matter. Use `--dry-run` to preview.

**Q: Generated CSV has wrong page/object assignments?**  
A: Edit the CSV manually or provide a mapping configuration file (future feature).

**Q: Why does my migrated CSV fail in the runner?**  
A: Ensure the runner supports STRICT column contracts (May 2026+). Migration automatically applies STRICT format. If using older runner, manually update column positions: params → Condition, timeout → Data.

**Q: Are dynamic params and timeouts placed correctly?**  
A: Yes. Migration automatically transforms to STRICT format: dynamic params in Condition, timeouts in Data. Generated CSV is ready to run.
