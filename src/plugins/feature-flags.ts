import {Commit} from '../commit';
import {execSync} from 'child_process';
import {ManifestPlugin} from '../plugin';

/**
 * Plugin that filters commits based on feature flags in commit messages.
 *
 * Feature flags are configured via environment variables: FEATURE_FLAG_NAME=true/false
 *
 * Commits with "Feature-Flag: FLAG_NAME" in their message will only be included
 * if the flag is enabled (FEATURE_FLAG_NAME=true) in environment variables.
 *
 * Commits without a feature flag are always included.
 */
export class FeatureFlagPlugin extends ManifestPlugin {
  private enabledFlags: Set<string>;
  private featureFlagFile: string;

  constructor(github: any, targetBranch: string, repositoryConfig: any) {
    super(github, targetBranch, repositoryConfig);

    this.featureFlagFile = process.env.FEATURE_FLAG_FILE || '.env.production';

    // Build set of enabled flags from environment variables and env file
    this.enabledFlags = new Set<string>();

    // Load from environment variables
    if (typeof process !== 'undefined' && process.env) {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('FEATURE_') && value === 'true') {
          this.enabledFlags.add(key);
        }
      }
    }

    // Load from feature flag file at HEAD
    const headFlags = this.readEnabledFlagsFromRef('HEAD');
    for (const flag of headFlags) {
      this.enabledFlags.add(flag);
    }

    console.log(
      `[FeatureFlagPlugin] Initialized with enabled flags: ${
        Array.from(this.enabledFlags).join(', ') || 'none'
      }`
    );
  }

  /**
   * Parse enabled FEATURE_* flags from env-style file content
   */
  private parseEnabledFlagsFromEnv(content: string): Set<string> {
    const enabled = new Set<string>();

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^(FEATURE_[A-Z0-9_]+)\s*=\s*(.+)$/i);
      if (!match) {
        continue;
      }

      const key = match[1];
      const rawValue = match[2].trim();
      const normalizedValue = rawValue
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase();

      if (normalizedValue === 'true') {
        enabled.add(key);
      }
    }

    return enabled;
  }

  /**
   * Read enabled flags from the feature flag file at a git ref
   */
  private readEnabledFlagsFromRef(ref: string): Set<string> {
    try {
      const output = execSync(`git show ${ref}:${this.featureFlagFile}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return this.parseEnabledFlagsFromEnv(output);
    } catch {
      return new Set<string>();
    }
  }

  /**
   * Get latest release tag reachable from HEAD
   */
  private getLatestTag(): string | undefined {
    try {
      const tag = execSync('git describe --tags --abbrev=0', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      return tag || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Detect flags that were disabled (or absent) at last release and are enabled now.
   */
  private getNewlyEnabledFlags(): string[] {
    const latestTag = this.getLatestTag();
    if (!latestTag) {
      return [];
    }

    const enabledAtHead = this.readEnabledFlagsFromRef('HEAD');
    const enabledAtLatestTag = this.readEnabledFlagsFromRef(latestTag);

    return Array.from(enabledAtHead).filter(
      flag => !enabledAtLatestTag.has(flag)
    );
  }

  /**
   * Add historical commits for newly enabled flags to current commit set.
   */
  private injectHistoricalCommitsForNewlyEnabledFlags(
    commitsByPath: Record<string, Commit[]>
  ): void {
    const newlyEnabledFlags = this.getNewlyEnabledFlags();
    if (newlyEnabledFlags.length === 0) {
      return;
    }

    console.log(
      `[FeatureFlagPlugin] Newly enabled flags: ${newlyEnabledFlags.join(', ')}`
    );

    const historicalCommits = this.findHistoricalCommits(newlyEnabledFlags);
    if (historicalCommits.length === 0) {
      return;
    }

    const existingShas = new Set<string>();
    for (const commits of Object.values(commitsByPath)) {
      for (const commit of commits) {
        if (commit.sha) {
          existingShas.add(commit.sha);
        }
      }
    }

    const dedupedHistoricalCommits = historicalCommits.filter(commit => {
      return !!commit.sha && !existingShas.has(commit.sha);
    });

    if (dedupedHistoricalCommits.length === 0) {
      return;
    }

    const targetPath = commitsByPath['.'] ? '.' : Object.keys(commitsByPath)[0];

    if (!targetPath) {
      return;
    }

    commitsByPath[targetPath].push(...dedupedHistoricalCommits);

    console.log(
      `[FeatureFlagPlugin] Injected ${dedupedHistoricalCommits.length} historical commits into path ${targetPath}`
    );
  }

  /**
   * Filter commits before strategies use them for changelog generation
   */
  async preconfigure(
    strategiesByPath: Record<string, any>,
    commitsByPath: Record<string, Commit[]>,
    _releasesByPath: Record<string, any>
  ): Promise<Record<string, any>> {
    this.injectHistoricalCommitsForNewlyEnabledFlags(commitsByPath);

    // Filter commits for each path IN PLACE
    for (const [path, commits] of Object.entries(commitsByPath)) {
      const originalCount = commits.length;

      // Filter the array in place
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < commits.length; readIndex++) {
        if (this.shouldIncludeCommit(commits[readIndex])) {
          commits[writeIndex] = commits[readIndex];
          writeIndex++;
        }
      }
      commits.length = writeIndex;

      console.log(
        `[FeatureFlagPlugin] Path ${path}: Filtered ${originalCount} commits down to ${commits.length}`
      );
    }

    return strategiesByPath;
  }

  /**
   * Find historical commits for newly enabled flags
   */
  private findHistoricalCommits(flags: string[]): Commit[] {
    const commits: Commit[] = [];
    const latestTag = this.getLatestTag();

    if (!latestTag) {
      return commits;
    }

    for (const flag of flags) {
      try {
        // Search for all commits mentioning this feature flag
        const grepPattern = `Feature-Flag: ${flag}`;
        const output = execSync(
          `git log ${latestTag} --grep="${grepPattern}" --regexp-ignore-case --format="%H|%s|%b|%an|%ae"`,
          {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore']}
        );

        if (output.trim()) {
          const lines = output.trim().split('\n');
          for (const line of lines) {
            // Extract only sha, subject, and body; skip author name and email
            const parts = line.split('|');
            const sha = parts[0];
            const subject = parts[1] || '';
            const body = parts[2] || '';

            // Skip if we don't have the minimum required data
            if (!sha || !subject) {
              continue;
            }

            // Reconstruct commit message
            const message = body ? `${subject}\n\n${body}` : subject;

            commits.push({
              sha,
              message,
              files: [], // Historical commits don't need file info for changelog
              type: this.extractCommitType(subject),
              scope: this.extractCommitScope(subject),
              bareMessage: subject,
              notes: [],
              references: [],
              breaking: false,
            } as Commit);

            console.log(
              `[FeatureFlagPlugin] Found historical commit ${sha.substring(
                0,
                7
              )} for ${flag}`
            );
          }
        }
      } catch (error) {
        console.error(
          `[FeatureFlagPlugin] Error finding commits for ${flag}:`,
          error
        );
      }
    }

    return commits;
  }

  /**
   * Extract commit type from conventional commit message (feat, fix, etc.)
   */
  private extractCommitType(message: string): string | undefined {
    const match = message.match(/^(\w+)(?:\([\w-]+\))?:/);
    return match ? match[1] : undefined;
  }

  /**
   * Extract commit scope from conventional commit message
   */
  private extractCommitScope(message: string): string | undefined {
    const match = message.match(/^\w+\(([\w-]+)\):/);
    return match ? match[1] : undefined;
  }

  /**
   * Determine if a commit should be included based on its feature flag
   */
  private shouldIncludeCommit(commit: Commit): boolean {
    // Check for commit override in PR body first
    let messageToCheck = commit.message;

    if (commit.pullRequest?.body) {
      const overrideMessage = (
        commit.pullRequest.body.split('BEGIN_COMMIT_OVERRIDE')[1] || ''
      )
        .split('END_COMMIT_OVERRIDE')[0]
        .trim();

      if (overrideMessage) {
        messageToCheck = overrideMessage;
      }
    }

    // Extract feature flag from commit message or override
    const flagMatch = messageToCheck.match(/Feature-Flag:\s*(\w+)/i);

    if (!flagMatch) {
      // No feature flag = always include
      return true;
    }

    const flag = flagMatch[1];
    const isEnabled = this.enabledFlags.has(flag);

    console.log(
      `[FeatureFlagPlugin] Commit ${commit.sha?.substring(
        0,
        7
      )}: Feature-Flag=${flag}, enabled=${isEnabled}`
    );

    return isEnabled;
  }
}

// Export factory function for release-please to load the plugin
export function factory(
  github: any,
  targetBranch: string,
  repositoryConfig: any
): FeatureFlagPlugin {
  return new FeatureFlagPlugin(github, targetBranch, repositoryConfig);
}
