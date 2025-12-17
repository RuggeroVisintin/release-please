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
  private previouslyEnabledFlags: Set<string>;

  constructor(github: any, targetBranch: string, repositoryConfig: any) {
    super(github, targetBranch, repositoryConfig);

    // Build set of enabled flags from environment variables only
    this.enabledFlags = new Set<string>();
    this.previouslyEnabledFlags = new Set<string>();

    // Load from environment variables
    if (typeof process !== 'undefined' && process.env) {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('FEATURE_')) {
          if (value === 'true') {
            this.enabledFlags.add(key);
          }
          // Track all feature flags seen (for detecting newly enabled ones)
          if (value === 'false') {
            this.previouslyEnabledFlags.add(key);
          }
        }
      }
    }

    console.log(
      `[FeatureFlagPlugin] Initialized with enabled flags: ${
        Array.from(this.enabledFlags).join(', ') || 'none'
      }`
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

    for (const flag of flags) {
      try {
        // Search for all commits mentioning this feature flag
        const grepPattern = `Feature-Flag: ${flag}`;
        const output = execSync(
          `git log --all --grep="${grepPattern}" --format="%H|%s|%b|%an|%ae"`,
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
    // Extract feature flag from commit message
    const flagMatch = commit.message.match(/Feature-Flag:\s*(\w+)/i);

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
