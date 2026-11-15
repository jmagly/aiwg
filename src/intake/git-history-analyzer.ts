/**
 * Git History Analyzer
 *
 * Analyzes Git repository history to extract project metadata including
 * velocity metrics, team composition, and project maturity for automated intake.
 *
 * @module src/intake/git-history-analyzer
 * @implements @.aiwg/requirements/use-cases/UC-003-generate-intake-from-codebase.md
 * @architecture @docs/architecture/cli/index.md
 * @tests @test/unit/intake/git-history-analyzer.test.ts
 * @command @.claude/commands/intake-from-codebase.md
 * @agent @agentic/code/frameworks/sdlc-complete/agents/intake-coordinator.md
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

export interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  message: string;
  date: Date;
}

export interface AuthorStats {
  name: string;
  email: string;
  commitCount: number;
  firstCommit: Date;
  lastCommit: Date;
  activeDays: number;
}

export interface VelocityMetrics {
  commitsPerDay: number;
  commitsPerWeek: number;
  commitsPerMonth: number;
  activeDaysRatio: number;
  teamVelocity: number;
  averageCommitsPerAuthor: number;
  peakDay: string;
  peakWeekCommits: number;
}

export type MaturityLevel = 'nascent' | 'mvp' | 'production' | 'mature';

export interface MaturityClassification {
  level: MaturityLevel;
  ageMonths: number;
  totalCommits: number;
  confidence: number;
  indicators: string[];
}

export interface TeamInfo {
  totalAuthors: number;
  activeAuthors: number;
  topContributors: AuthorStats[];
  authorDistribution: Map<string, number>;
  issoloProject: boolean;
  teamSize: 'solo' | 'small' | 'medium' | 'large';
}

export interface BranchInfo {
  name: string;
  isDefault: boolean;
  commitCount: number;
  lastActivity: Date;
}

export interface RepositoryMetadata {
  path: string;
  name: string;
  firstCommitDate: Date;
  lastCommitDate: Date;
  totalCommits: number;
  branches: BranchInfo[];
  defaultBranch: string;
  hasRemote: boolean;
  remoteUrl?: string;
}

export interface GitAnalysisResult {
  repository: RepositoryMetadata;
  velocity: VelocityMetrics;
  maturity: MaturityClassification;
  team: TeamInfo;
  commits: CommitInfo[];
  analysisTimeMs: number;
  analyzedAt: string;
}

export interface AnalyzerOptions {
  maxCommits?: number;
  sinceMonths?: number;
  includeAllBranches?: boolean;
  excludeAuthors?: string[];
  excludePatterns?: RegExp[];
}

const DEFAULT_OPTIONS: Required<AnalyzerOptions> = {
  maxCommits: 10000,
  sinceMonths: 12,
  includeAllBranches: false,
  excludeAuthors: [],
  excludePatterns: []
};

/**
 * Git History Analyzer
 *
 * Extracts project metadata from Git commit history for automated intake generation.
 */
export class GitHistoryAnalyzer {
  private repoPath: string;
  private options: Required<AnalyzerOptions>;

  constructor(repoPath: string, options: AnalyzerOptions = {}) {
    this.repoPath = repoPath;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Run comprehensive Git history analysis
   */
  async analyze(): Promise<GitAnalysisResult> {
    const startTime = Date.now();

    // Validate repository
    await this.validateRepository();

    // Gather data in parallel where possible
    const [
      commits,
      repository,
      branches
    ] = await Promise.all([
      this.getCommitHistory(),
      this.getRepositoryMetadata(),
      this.getBranches()
    ]);

    // Calculate derived metrics
    const velocity = this.calculateVelocity(commits);
    const maturity = this.classifyMaturity(commits, repository);
    const team = this.extractTeamInfo(commits);

    // Update repository with branch info
    repository.branches = branches;

    const analysisTimeMs = Date.now() - startTime;

    return {
      repository,
      velocity,
      maturity,
      team,
      commits: commits.slice(0, 100), // Return only last 100 commits
      analysisTimeMs,
      analyzedAt: new Date().toISOString()
    };
  }

  /**
   * Validate that the path is a Git repository
   */
  async validateRepository(): Promise<void> {
    const gitDir = join(this.repoPath, '.git');
    if (!existsSync(gitDir)) {
      throw new Error(`Not a Git repository: ${this.repoPath}`);
    }

    // Check Git is available
    try {
      await this.executeGitCommand('--version');
    } catch {
      throw new Error('Git is not installed or not in PATH');
    }
  }

  /**
   * Execute a Git command in the repository
   */
  async executeGitCommand(args: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(`git ${args}`, {
        cwd: this.repoPath,
        maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large repos
      });

      if (stderr && !stderr.includes('warning:')) {
        console.warn('Git warning:', stderr);
      }

      return stdout.trim();
    } catch (error: unknown) {
      const err = error as Error & { stderr?: string };
      throw new Error(`Git command failed: ${err.message}${err.stderr ? ` (${err.stderr})` : ''}`);
    }
  }

  /**
   * Get commit history from Git log
   */
  async getCommitHistory(): Promise<CommitInfo[]> {
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - this.options.sinceMonths);
    const sinceStr = sinceDate.toISOString().split('T')[0];

    const branchFlag = this.options.includeAllBranches ? '--all' : '';
    const format = '%H|%an|%ae|%at|%s';

    const output = await this.executeGitCommand(
      `log ${branchFlag} --since="${sinceStr}" --pretty=format:"${format}" -n ${this.options.maxCommits}`
    );

    if (!output) {
      return [];
    }

    return this.parseCommitLog(output);
  }

  /**
   * Parse Git log output into CommitInfo objects
   */
  parseCommitLog(logOutput: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    const lines = logOutput.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 5) continue;

      const [hash, author, email, timestampStr, ...messageParts] = parts;
      const timestamp = parseInt(timestampStr, 10);
      const message = messageParts.join('|');

      // Apply exclusion filters
      if (this.options.excludeAuthors.includes(author)) continue;
      if (this.options.excludePatterns.some(p => p.test(message))) continue;

      commits.push({
        hash,
        author,
        email,
        timestamp,
        message,
        date: new Date(timestamp * 1000)
      });
    }

    return commits;
  }

  /**
   * Get repository metadata
   */
  async getRepositoryMetadata(): Promise<RepositoryMetadata> {
    // Get first commit date
    const firstCommitTimestamp = await this.executeGitCommand(
      'log --reverse --pretty=format:"%at" | head -1'
    ).catch(() => '');

    // Get last commit date
    const lastCommitTimestamp = await this.executeGitCommand(
      'log -1 --pretty=format:"%at"'
    ).catch(() => '');

    // Get total commit count
    const commitCountStr = await this.executeGitCommand(
      'rev-list --count HEAD'
    ).catch(() => '0');

    // Get default branch
    const defaultBranch = await this.executeGitCommand(
      'symbolic-ref --short HEAD'
    ).catch(() => 'main');

    // Get remote URL
    const remoteUrl = await this.executeGitCommand(
      'remote get-url origin'
    ).catch(() => '');

    // Extract repo name from path or remote
    const name = this.extractRepoName(this.repoPath, remoteUrl);

    return {
      path: this.repoPath,
      name,
      firstCommitDate: firstCommitTimestamp
        ? new Date(parseInt(firstCommitTimestamp, 10) * 1000)
        : new Date(),
      lastCommitDate: lastCommitTimestamp
        ? new Date(parseInt(lastCommitTimestamp, 10) * 1000)
        : new Date(),
      totalCommits: parseInt(commitCountStr, 10) || 0,
      branches: [],
      defaultBranch,
      hasRemote: !!remoteUrl,
      remoteUrl: remoteUrl || undefined
    };
  }

  /**
   * Get branch information
   */
  async getBranches(): Promise<BranchInfo[]> {
    const output = await this.executeGitCommand(
      'for-each-ref --format="%(refname:short)|%(committerdate:unix)|%(objectname:short)" refs/heads/'
    ).catch(() => '');

    if (!output) {
      return [];
    }

    const defaultBranch = await this.executeGitCommand('symbolic-ref --short HEAD').catch(() => 'main');

    const branches: BranchInfo[] = [];
    const lines = output.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const [name, timestampStr] = line.split('|');
      if (!name) continue;

      const commitCount = parseInt(
        await this.executeGitCommand(`rev-list --count ${name}`).catch(() => '0'),
        10
      );

      branches.push({
        name,
        isDefault: name === defaultBranch,
        commitCount,
        lastActivity: new Date(parseInt(timestampStr, 10) * 1000)
      });
    }

    return branches.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  }

  /**
   * Calculate velocity metrics from commit history
   */
  calculateVelocity(commits: CommitInfo[]): VelocityMetrics {
    if (commits.length === 0) {
      return {
        commitsPerDay: 0,
        commitsPerWeek: 0,
        commitsPerMonth: 0,
        activeDaysRatio: 0,
        teamVelocity: 0,
        averageCommitsPerAuthor: 0,
        peakDay: '',
        peakWeekCommits: 0
      };
    }

    // Sort commits by date
    const sortedCommits = [...commits].sort((a, b) => a.timestamp - b.timestamp);
    const firstCommit = sortedCommits[0];
    const lastCommit = sortedCommits[sortedCommits.length - 1];

    // Calculate time range
    const msPerDay = 24 * 60 * 60 * 1000;
    const totalDays = Math.max(1, (lastCommit.timestamp - firstCommit.timestamp) * 1000 / msPerDay);
    const totalWeeks = Math.max(1, totalDays / 7);
    const totalMonths = Math.max(1, totalDays / 30);

    // Count active days
    const activeDays = new Set(
      commits.map(c => new Date(c.timestamp * 1000).toISOString().split('T')[0])
    );

    // Count commits by day and week
    const commitsByDay = new Map<string, number>();
    const commitsByWeek = new Map<string, number>();

    for (const commit of commits) {
      const date = new Date(commit.timestamp * 1000);
      const dayKey = date.toISOString().split('T')[0];
      const weekKey = this.getWeekKey(date);

      commitsByDay.set(dayKey, (commitsByDay.get(dayKey) || 0) + 1);
      commitsByWeek.set(weekKey, (commitsByWeek.get(weekKey) || 0) + 1);
    }

    // Find peak day and week
    let peakDay = '';
    let peakDayCommits = 0;
    commitsByDay.forEach((count, day) => {
      if (count > peakDayCommits) {
        peakDayCommits = count;
        peakDay = day;
      }
    });

    let peakWeekCommits = 0;
    commitsByWeek.forEach((count) => {
      if (count > peakWeekCommits) {
        peakWeekCommits = count;
      }
    });

    // Count unique authors
    const uniqueAuthors = new Set(commits.map(c => c.author)).size;

    return {
      commitsPerDay: commits.length / totalDays,
      commitsPerWeek: commits.length / totalWeeks,
      commitsPerMonth: commits.length / totalMonths,
      activeDaysRatio: activeDays.size / totalDays,
      teamVelocity: uniqueAuthors > 0 ? commits.length / totalDays / uniqueAuthors : 0,
      averageCommitsPerAuthor: uniqueAuthors > 0 ? commits.length / uniqueAuthors : 0,
      peakDay,
      peakWeekCommits
    };
  }

  /**
   * Classify project maturity based on age and activity
   */
  classifyMaturity(commits: CommitInfo[], repository: RepositoryMetadata): MaturityClassification {
    const now = new Date();
    const ageMs = now.getTime() - repository.firstCommitDate.getTime();
    const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
    const totalCommits = repository.totalCommits;

    const indicators: string[] = [];
    let level: MaturityLevel;
    let confidence = 0.8;

    // Classify based on age and commit count
    if (ageMonths < 3 && totalCommits < 50) {
      level = 'nascent';
      indicators.push(`Project age: ${ageMonths.toFixed(1)} months`);
      indicators.push(`Total commits: ${totalCommits}`);
      indicators.push('Early development phase');
    } else if (ageMonths < 6 || totalCommits < 200) {
      level = 'mvp';
      indicators.push(`Project age: ${ageMonths.toFixed(1)} months`);
      indicators.push(`Total commits: ${totalCommits}`);
      indicators.push('MVP/prototype phase');

      // Adjust confidence if mixed signals
      if (ageMonths >= 6 && totalCommits < 200) {
        confidence = 0.6;
        indicators.push('Low activity for age - may be maintenance mode');
      }
    } else if (ageMonths < 12 || totalCommits < 1000) {
      level = 'production';
      indicators.push(`Project age: ${ageMonths.toFixed(1)} months`);
      indicators.push(`Total commits: ${totalCommits}`);
      indicators.push('Active production development');
    } else {
      level = 'mature';
      indicators.push(`Project age: ${ageMonths.toFixed(1)} months`);
      indicators.push(`Total commits: ${totalCommits}`);
      indicators.push('Mature project with established history');
    }

    // Additional indicators
    if (commits.length > 0) {
      const recentCommits = commits.filter(c => {
        const commitAge = (now.getTime() - c.date.getTime()) / (30 * 24 * 60 * 60 * 1000);
        return commitAge < 1;
      });

      if (recentCommits.length === 0) {
        indicators.push('No commits in last 30 days - may be maintenance mode');
        confidence *= 0.9;
      } else if (recentCommits.length > 10) {
        indicators.push('Active development in last 30 days');
      }
    }

    return {
      level,
      ageMonths,
      totalCommits,
      confidence,
      indicators
    };
  }

  /**
   * Extract team information from commits
   */
  extractTeamInfo(commits: CommitInfo[]): TeamInfo {
    const authorMap = new Map<string, AuthorStats>();
    const now = new Date();
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    for (const commit of commits) {
      const key = commit.email;
      const existing = authorMap.get(key);

      if (existing) {
        existing.commitCount++;
        if (commit.date < existing.firstCommit) {
          existing.firstCommit = commit.date;
        }
        if (commit.date > existing.lastCommit) {
          existing.lastCommit = commit.date;
        }
      } else {
        authorMap.set(key, {
          name: commit.author,
          email: commit.email,
          commitCount: 1,
          firstCommit: commit.date,
          lastCommit: commit.date,
          activeDays: 0
        });
      }
    }

    // Calculate active days per author
    const authorDays = new Map<string, Set<string>>();
    for (const commit of commits) {
      const key = commit.email;
      const dayKey = commit.date.toISOString().split('T')[0];

      if (!authorDays.has(key)) {
        authorDays.set(key, new Set());
      }
      authorDays.get(key)!.add(dayKey);
    }

    authorDays.forEach((days, email) => {
      const author = authorMap.get(email);
      if (author) {
        author.activeDays = days.size;
      }
    });

    // Sort authors by commit count
    const sortedAuthors = Array.from(authorMap.values())
      .sort((a, b) => b.commitCount - a.commitCount);

    // Count active authors (committed in last 3 months)
    const activeAuthors = sortedAuthors.filter(a => a.lastCommit >= threeMonthsAgo);

    // Create distribution map
    const authorDistribution = new Map<string, number>();
    sortedAuthors.forEach(a => authorDistribution.set(a.name, a.commitCount));

    // Determine team size category
    let teamSize: 'solo' | 'small' | 'medium' | 'large';
    const totalAuthors = sortedAuthors.length;

    if (totalAuthors <= 1) {
      teamSize = 'solo';
    } else if (totalAuthors <= 5) {
      teamSize = 'small';
    } else if (totalAuthors <= 15) {
      teamSize = 'medium';
    } else {
      teamSize = 'large';
    }

    return {
      totalAuthors,
      activeAuthors: activeAuthors.length,
      topContributors: sortedAuthors.slice(0, 10),
      authorDistribution,
      issoloProject: totalAuthors <= 1,
      teamSize
    };
  }

  /**
   * Get author statistics using git shortlog
   */
  async getAuthorStats(): Promise<AuthorStats[]> {
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - this.options.sinceMonths);
    const sinceStr = sinceDate.toISOString().split('T')[0];

    const output = await this.executeGitCommand(
      `shortlog -sne --since="${sinceStr}"`
    ).catch(() => '');

    if (!output) {
      return [];
    }

    const stats: AuthorStats[] = [];
    const lines = output.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s+(.+)\s+<(.+)>$/);
      if (match) {
        stats.push({
          name: match[2].trim(),
          email: match[3].trim(),
          commitCount: parseInt(match[1], 10),
          firstCommit: new Date(),
          lastCommit: new Date(),
          activeDays: 0
        });
      }
    }

    return stats;
  }

  /**
   * Helper to get week key for a date
   */
  private getWeekKey(date: Date): string {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + 1) / 7);
    return `${date.getFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
  }

  /**
   * Extract repository name from path or remote URL
   */
  private extractRepoName(path: string, remoteUrl: string): string {
    // Try to extract from remote URL first
    if (remoteUrl) {
      const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
      if (match) {
        return match[1];
      }
    }

    // Fall back to directory name
    const parts = path.replace(/\\/g, '/').split('/').filter(p => p);
    return parts[parts.length - 1] || 'unknown';
  }
}

/**
 * Quick analysis function for simple use cases
 */
export async function analyzeGitHistory(
  repoPath: string,
  options?: AnalyzerOptions
): Promise<GitAnalysisResult> {
  const analyzer = new GitHistoryAnalyzer(repoPath, options);
  return analyzer.analyze();
}

/**
 * Get project maturity classification
 */
export async function getProjectMaturity(repoPath: string): Promise<MaturityClassification> {
  const analyzer = new GitHistoryAnalyzer(repoPath, { maxCommits: 1000 });
  const result = await analyzer.analyze();
  return result.maturity;
}

/**
 * Get team composition from Git history
 */
export async function getTeamComposition(repoPath: string): Promise<TeamInfo> {
  const analyzer = new GitHistoryAnalyzer(repoPath, { sinceMonths: 12 });
  const result = await analyzer.analyze();
  return result.team;
}
