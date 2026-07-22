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

    const allFcs = [...this.coverageMap.values()];
    const totalPct = this.aggregatePct(allFcs);
    const totalLines = allFcs.reduce((s, f) => s + f.metrics.totalLines, 0);
    const coveredLines = allFcs.reduce((s, f) => s + f.metrics.coveredLines, 0);
    const summary = new CoverageSummaryItem(totalPct, allFcs.length, coveredLines, totalLines, this.thresholds);

    return [summary, ...tree];
  }

  private buildTree(): CoverageTreeItem[] {
    // Group files into a virtual folder tree
    const root: Record<string, any> = {};

    // Compute relative paths and strip the common directory prefix
    const entries = [...this.coverageMap.entries()].map(([absPath, fc]) => ({
      rel: path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/'),
      absPath,
      fc,
    }));

    const prefixParts = this.commonDirPrefix(entries.map(e => e.rel));

    for (const { rel, fc } of entries) {
      const parts = rel.split('/').slice(prefixParts);
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] ?? {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = fc;
    }

    return this.nodeToItems(root, this.workspaceRoot);
  }

  /**
   * Returns the number of leading directory segments shared by all paths.
   * Only directory segments (not the filename) are considered.
   * e.g. ["src/main/java/com/Foo.java", "src/main/java/com/Bar.java"] → 4
   */
  private commonDirPrefix(relPaths: string[]): number {
    if (relPaths.length === 0) return 0;
    const dirParts = relPaths.map(p => p.split('/').slice(0, -1)); // drop filename
    const minLen = Math.min(...dirParts.map(p => p.length));
    let common = 0;
    for (let i = 0; i < minLen; i++) {
      const segment = dirParts[0][i];
      if (dirParts.every(p => p[i] === segment)) {
        common++;
      } else {
        break;
      }
    }
    return common;
  }

  private nodeToItems(node: Record<string, any>, currentPath: string): CoverageTreeItem[] {
    const items: CoverageTreeItem[] = [];

    for (const [name, value] of Object.entries(node)) {
      const childPath = path.join(currentPath, name);

      if (value && typeof value === 'object' && 'filePath' in value) {
        // It's a FileCoverage
        const fc = value as FileCoverage;
        items.push(new CoverageFileItem(name, fc, this.thresholds, childPath));
      } else {
        // It's a folder — compute aggregate
        const children = this.nodeToItems(value as Record<string, any>, childPath);
        const allFcs = this.collectFileCoverages(value as Record<string, any>);
        const aggPct = this.aggregatePct(allFcs);
        items.push(new CoverageFolderItem(name, children, aggPct, this.thresholds));
      }
    }

    return items.sort((a, b) => {
      // Folders first, then files
      const aIsFolder = a instanceof CoverageFolderItem;
      const bIsFolder = b instanceof CoverageFolderItem;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.label!.toString().localeCompare(b.label!.toString());
    });
  }

  private collectFileCoverages(node: Record<string, any>): FileCoverage[] {
    const result: FileCoverage[] = [];
    for (const val of Object.values(node)) {
      if (val.lines && val.branches) result.push(val as FileCoverage);
      else result.push(...this.collectFileCoverages(val as Record<string, any>));
    }
    return result;
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

class CoverageSummaryItem extends CoverageTreeItem {
  constructor(pct: number, coveredLines: number, totalLines: number, thresholds: { low: number; medium: number }) {
    super('Total Coverage', vscode.TreeItemCollapsibleState.None);
    this.description = `${pct}%  ·  ${coveredLines.toLocaleString()}/${totalLines.toLocaleString()} lines`;
    this.iconPath = iconForPct(pct, thresholds);
    this.contextValue = 'coverlens.summary';
  }
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
    const brPct = fc.metrics.totalBranches > 0 ? `  ·  ${fc.metrics.branchPercent}%` : '';
    this.description = `${pct}%${brPct}`;
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

class CoverageFolderItem extends CoverageTreeItem {
  constructor(
    name: string,
    children: CoverageTreeItem[],
    pct: number,
    thresholds: { low: number; medium: number }
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.children = children;
    this.description = `${pct}%`;
    this.iconPath = iconForPct(pct, thresholds);
    this.contextValue = 'coverlens.folder';
  }
}

function iconForPct(pct: number, t: { low: number; medium: number }): vscode.ThemeIcon {
  if (pct >= t.medium) return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  if (pct >= t.low)    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconQueued'));
  return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
}