# Obsidian community plugin review fixes

This file explains the findings from `Error.md` and the changes made to resolve them.

## Errors

### Unsupported Obsidian APIs

The plugin declared Obsidian `0.15.0`, but uses APIs introduced after that release, including `workspace.getLeaf("tab")` and current menu APIs.

**Fix:** `manifest.json` now declares `minAppVersion` as `1.0.0`, matching the APIs used by the plugin.

### Direct static style assignments

The node-note modal assigned fixed layout values through `element.style.setProperty`, which bypasses Obsidian's CSS conventions.

**Fix:** the static modal and textarea layout rules were moved to `styles.css`; the TypeScript now only applies CSS classes.

### Settings heading created with raw HTML

Obsidian settings pages expect headings to use the `Setting` API for consistent styling and accessibility.

**Fix:** the raw `<h2>` was replaced with `new Setting(containerEl).setName(...).setHeading()`.

## Warnings and recommendation

### Deprecated `builtin-modules` package

The build only needs Node's built-in module list.

**Fix:** the dependency was removed and `esbuild.config.mjs` now imports `builtinModules` from the native `node:module` API.

### Global `document` usage

The global document points to Obsidian's main window and can create elements in the wrong window when a view is opened in a popout.

**Fix:** DOM creation and hit testing in the mind-map view and canvas now use Obsidian's `activeDocument`.

### Cross-window element checks

Native `instanceof HTMLInputElement` and `instanceof HTMLTextAreaElement` can fail when the element belongs to a popout window.

**Fix:** input and textarea checks now use Obsidian's cross-window-safe `element.instanceOf(...)` helper after narrowing the target to an element.

### Unnecessary type assertion and unsafe call

The PDF writer forced a `Uint8Array` through an unnecessary double assertion, and the xref formatter used a form the linter treated as unsafe.

**Fix:** byte buffers are converted to an `ArrayBuffer` with `Uint8Array.from(bytes).buffer`, and numeric offsets call `toString()` directly before `padStart()`.

### Control characters in a regular expression

The filename sanitizer embedded the control-character range directly in a regular expression, triggering `no-control-regex`.

**Fix:** it now checks each character's code and replaces control or filesystem-reserved characters without a control-character regex.

### Unsafe YAML values and explicit `any`

`parseYaml` returns untrusted data. The parser previously accessed that data through `any`, so malformed frontmatter could reach typed code without validation.

**Fix:** parsed YAML is kept as `unknown`, narrowed with a small record guard, and every node, position, view, and connection field is type-checked before use.

### Deprecated `workspace.activeLeaf`

Reading `activeLeaf` is deprecated and was used both by the save command and the view's active-state check.

**Fix:** both sites now use `workspace.getActiveViewOfType(MindMapView)`.

## Verification

Run:

```sh
npm run build
npm test
```

Both commands pass after these changes. Re-run the Obsidian community plugin review on the newly built `main.js` before submitting again.
