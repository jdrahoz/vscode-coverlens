import * as vscode from 'vscode';
import * as path from 'path';
import { CoverageMap, FileCoverage } from '../coverage/types';

export class CoverageTreeProvider implements vscode.TreeDataProvider<CoverageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CoverageTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private coverageMap: CoverageMap = new Map();
  private workspaceRoot: string;
  private thresholds = { low: 50, medium: 80 };
  private disposables: vscode.Disposable[] = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.readThresholds();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('coverlens.thresholds')) {
          this.readThresholds();
          this._onDidChangeTreeData.fire(null);
        }
      })
    );
  }

  private readThresholds(): void {
    const cfg = vscode.workspace.getConfiguration('coverlens');
    this.thresholds.low    = cfg.get<number>('thresholds.low',    50);
    this.thresholds.medium = cfg.get<number>('thresholds.medium', 80);
  }

  setCoverage(map: CoverageMap): void {
    this.coverageMap = map;
    this._onDidChangeTreeData.fire(null);
  }

  refresh(): void { this._onDidChangeTreeData.fire(null); }

  getTreeItem(element: CoverageTreeItem): vscode.TreeItem { return element; }

  getChildren(element?: CoverageTreeItem): CoverageTreeItem[] {
    if (element) {
      // Folder: return its children
      return element.children ?? [];
    }

    // Root: build folder tree from coverage map
    const tree = this.buildTree();
    if (tree.length === 0) {
      const placeholder = new vscode.TreeItem('No coverage data found');
      placeholder.description = 'Run tests or check coverlens.coverageFiles setting';
      placeholder.iconPath = new vscode.ThemeIcon('info');
      return [placeholder as CoverageTreeItem];
    }
    return tree;
  }

  private buildTree(): CoverageTreeItem[] {
    if (this.coverageMap.size === 0) return [];

    // Compute relative paths for all entries
    const entries: Array<{ rel: string; absPath: string; fc: FileCoverage }> = [];
    for (const [absPath, fc] of this.coverageMap) {
      const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
      entries.push({ rel, absPath, fc });
    }

    // Strip the longest common directory prefix shared by all files so that
    // paths like "src/main/java/com/example/Foo.java" become "com/example/Foo.java".
    const prefix = commonDirPrefix(entries.map(e => e.rel));

    // Group by package: all directory segments (dot-joined) above the filename.
    // Files at the root (no directory segments left after prefix removal) use
    // the empty string as a sentinel for an "(root)" package label.
    const packageMap = new Map<string, Array<{ name: string; absPath: string; fc: FileCoverage }>>();

    for (const { rel, absPath, fc } of entries) {
      const stripped = prefix ? rel.slice(prefix.length) : rel;
      const parts = stripped.split('/');
      const fileName = parts[parts.length - 1];
      const pkgLabel = parts.slice(0, -1).join('.');

      if (!packageMap.has(pkgLabel)) packageMap.set(pkgLabel, []);
      packageMap.get(pkgLabel)!.push({ name: fileName, absPath, fc });
    }

    // Build one CoveragePackageItem per package
    const items: CoverageTreeItem[] = [];
    for (const [pkgLabel, files] of packageMap) {
      const fileItems = files
        .map(({ name, absPath, fc }) => new CoverageFileItem(name, fc, this.thresholds, absPath))
        .sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));

      const aggPct = this.aggregatePct(files.map(f => f.fc));
      const displayLabel = pkgLabel || '(root)';
      items.push(new CoveragePackageItem(displayLabel, fileItems, aggPct));
    }

    return items.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
  }

  private aggregatePct(fcs: FileCoverage[]): number {
    if (!fcs.length) return 0;
    const totalLines = fcs.reduce((s, f) => s + f.metrics.totalLines, 0);
    const coveredLines = fcs.reduce((s, f) => s + f.metrics.coveredLines, 0);
    return totalLines === 0 ? 100 : Math.round((coveredLines / totalLines) * 100);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

abstract class CoverageTreeItem extends vscode.TreeItem {
  children?: CoverageTreeItem[];
}

class CoverageFileItem extends CoverageTreeItem {
  constructor(
    name: string,
    fc: FileCoverage,
    thresholds: { low: number; medium: number },
    absPath: string
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    const pct = fc.metrics.linePercent;
    const brPct = fc.metrics.totalBranches > 0 ? ` | br: ${fc.metrics.branchPercent}%` : '';
    this.description = `${pct}%${brPct}`;
    this.tooltip = `Lines: ${fc.metrics.coveredLines}/${fc.metrics.totalLines} (${pct}%)\nBranches: ${fc.metrics.coveredBranches}/${fc.metrics.totalBranches}`;
    this.iconPath = iconForPct(pct, thresholds);
    this.resourceUri = vscode.Uri.file(absPath);
    this.command = {
      command: 'vscode.open',
      title: 'Open file',
      arguments: [vscode.Uri.file(absPath)]
    };
    this.contextValue = 'coverlens.file';
  }
}

class CoveragePackageItem extends CoverageTreeItem {
  constructor(
    label: string,
    children: CoverageTreeItem[],
    pct: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.children = children;
    this.description = `${pct}%`;
    this.iconPath = new vscode.ThemeIcon('package');
    this.contextValue = 'coverlens.package';
  }
}

/**
 * Returns the longest common directory prefix shared by all relative paths,
 * always ending with a trailing slash so it can be sliced off cleanly.
 * e.g. ["src/main/java/com/Foo.java", "src/main/java/com/Bar.java"]
 *      → "src/main/java/"
 */
function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '';

  // Work with directory-segment arrays only (drop the filename)
  const dirParts = paths.map(p => p.split('/').slice(0, -1));

  const shortest = dirParts.reduce((a, b) => (a.length <= b.length ? a : b));
  let common: string[] = [];
  for (let i = 0; i < shortest.length; i++) {
    if (dirParts.every(parts => parts[i] === shortest[i])) {
      common.push(shortest[i]);
    } else {
      break;
    }
  }

  return common.length > 0 ? common.join('/') + '/' : '';
}

function iconForPct(pct: number, t: { low: number; medium: number }): vscode.ThemeIcon {
  if (pct >= t.medium) return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  if (pct >= t.low)    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconQueued'));
  return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
}
