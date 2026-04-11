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
  ): Promise<void> {
    const newlyEnabledFlags = this.getNewlyEnabledFlags();
    if (newlyEnabledFlags.length === 0) {
      return Promise.resolve();
    }

    console.log(
      `[FeatureFlagPlugin] Newly enabled flags: ${newlyEnabledFlags.join(', ')}`
    );

    const historicalCommits = this.findHistoricalCommits(newlyEnabledFlags);

    return this.findHistoricalOverridePullRequestCommits(
      newlyEnabledFlags
    ).then(overrideCommits => {
      const allHistoricalCommits = [...historicalCommits, ...overrideCommits];
      if (allHistoricalCommits.length === 0) {
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

      const dedupedHistoricalCommits = allHistoricalCommits.filter(commit => {
        return !!commit.sha && !existingShas.has(commit.sha);
      });

      if (dedupedHistoricalCommits.length === 0) {
        return;
      }

      const targetPath = commitsByPath['.']
        ? '.'
        : Object.keys(commitsByPath)[0];

      if (!targetPath) {
        return;
      }

      commitsByPath[targetPath].push(...dedupedHistoricalCommits);

      console.log(
        `[FeatureFlagPlugin] Injected ${dedupedHistoricalCommits.length} historical commits into path ${targetPath}`
      );
    });
  }

  /**
   * Filter commits before strategies use them for changelog generation
   */
  async preconfigure(
    strategiesByPath: Record<string, any>,
    commitsByPath: Record<string, Commit[]>,
    _releasesByPath: Record<string, any>
  ): Promise<Record<string, any>> {
    await this.injectHistoricalCommitsForNewlyEnabledFlags(commitsByPath);

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
          `git log ${latestTag} --grep="${grepPattern}" --regexp-ignore-case --format="%H%x1f%s%x1f%b%x1e"`,
          {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore']}
        );

        if (output.trim()) {
          const records = output.split('\x1e');
          for (const record of records) {
            const trimmedRecord = record.trim();
            if (!trimmedRecord) {
              continue;
            }

            const parts = trimmedRecord.split('\x1f');
            const sha = parts[0]?.trim();
            const subject = parts[1]?.trim() || '';
            const body = parts.slice(2).join('\x1f').trim();

            // Skip if we don't have the minimum required data
            if (!sha || !subject) {
              continue;
            }

            // Reconstruct commit message
            const message = body ? `${subject}\n\n${body}` : subject;
            const effectiveMessage = this.getEffectiveMessage(message);
            const effectiveSubject = effectiveMessage
              .split('\n')
              .find(line => line.trim().length > 0)
              ?.trim();

            if (!effectiveSubject) {
              continue;
            }

            commits.push({
              sha,
              message,
              files: [], // Historical commits don't need file info for changelog
              type: this.extractCommitType(effectiveSubject),
              scope: this.extractCommitScope(effectiveSubject),
              bareMessage: effectiveSubject,
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
   * Find historical merged PR commits whose override block contains newly enabled flags.
   */
  private async findHistoricalOverridePullRequestCommits(
    flags: string[]
  ): Promise<Commit[]> {
    const flagSet = new Set(flags);
    const commits: Commit[] = [];

    try {
      const prs = await this.findMergedPullRequestsWithFeatureFlagBody(500);
      for (const pr of prs) {
        const mergeSha = pr.mergeCommitOid || pr.sha;
        if (!mergeSha) {
          continue;
        }

        const overrideMessage = this.extractOverrideMessage(pr.body || '');
        if (!overrideMessage) {
          continue;
        }

        const flagMatch = overrideMessage.match(/Feature-Flag:\s*(\w+)/i);
        if (!flagMatch || !flagSet.has(flagMatch[1])) {
          continue;
        }

        const effectiveSubject = overrideMessage
          .split('\n')
          .find(line => line.trim().length > 0)
          ?.trim();

        if (!effectiveSubject) {
          continue;
        }

        commits.push({
          sha: mergeSha,
          message: overrideMessage,
          files: pr.files || [],
          pullRequest: {
            ...pr,
            sha: mergeSha,
          },
          type: this.extractCommitType(effectiveSubject),
          scope: this.extractCommitScope(effectiveSubject),
          bareMessage: effectiveSubject,
          notes: [],
          references: [],
          breaking: false,
        } as Commit);

        console.log(
          `[FeatureFlagPlugin] Found historical PR override commit ${mergeSha.substring(
            0,
            7
          )} for ${flagMatch[1]} (PR #${pr.number})`
        );
      }
    } catch {
      return commits;
    }

    return commits;
  }

  /**
   * Find merged pull requests that mention Feature-Flag in the PR body.
   */
  private async findMergedPullRequestsWithFeatureFlagBody(
    maxResults: number
  ): Promise<any[]> {
    const github = this.github as any;
    const owner = github?.repository?.owner;
    const repo = github?.repository?.repo;
    const octokit = github?.octokit;

    if (!owner || !repo || !octokit) {
      return this.findMergedPullRequestsWithFeatureFlagBodyFallback(maxResults);
    }

    const query = `repo:${owner}/${repo} is:pr is:merged base:${this.targetBranch} in:body "Feature-Flag:"`;

    const prs: any[] = [];
    let page = 1;
    const perPage = 100;

    console.log(
      `[FeatureFlagPlugin] Searching merged PRs with Feature-Flag overrides (branch=${this.targetBranch}, maxResults=${maxResults})`
    );

    try {
      while (prs.length < maxResults) {
        const response = await octokit.request('GET /search/issues', {
          q: query,
          per_page: perPage,
          page,
          sort: 'updated',
          order: 'desc',
        });

        const items = response?.data?.items || [];
        console.log(
          `[FeatureFlagPlugin] Search page ${page}: ${items.length} candidate PRs`
        );
        if (items.length === 0) {
          break;
        }

        for (const item of items) {
          if (prs.length >= maxResults) {
            break;
          }

          const number = item?.number;
          if (!number) {
            continue;
          }

          try {
            const pr = await this.github.getPullRequest(number);
            prs.push(pr);
          } catch {
            // Skip PRs that cannot be fetched for any reason.
          }
        }

        page++;
      }

      console.log(
        `[FeatureFlagPlugin] Search API returned ${prs.length} merged PRs with Feature-Flag in body`
      );

      return prs;
    } catch (error) {
      console.warn(
        '[FeatureFlagPlugin] Search API failed, falling back to merged PR iterator:',
        error
      );
      return this.findMergedPullRequestsWithFeatureFlagBodyFallback(maxResults);
    }
  }

  /**
   * Fallback for environments where octokit is unavailable on the github object.
   */
  private async findMergedPullRequestsWithFeatureFlagBodyFallback(
    maxResults: number
  ): Promise<any[]> {
    const prs: any[] = [];

    for await (const pr of this.github.pullRequestIterator(
      this.targetBranch,
      'MERGED',
      maxResults,
      false
    )) {
      if ((pr.body || '').match(/Feature-Flag:\s*(\w+)/i)) {
        prs.push(pr);
      }
    }

    console.log(
      `[FeatureFlagPlugin] Fallback iterator returned ${prs.length} merged PRs with Feature-Flag in body`
    );

    return prs;
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
    const messageToCheck = this.getFeatureFlagMessage(commit);

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

  /**
   * Extract commit override block content from any text that may contain it.
   */
  private extractOverrideMessage(text: string): string | undefined {
    const match = text.match(
      /BEGIN_COMMIT_OVERRIDE([\s\S]*?)END_COMMIT_OVERRIDE/i
    );
    const override = match?.[1]?.trim();
    return override || undefined;
  }

  /**
   * Return effective message for parsing commit metadata.
   */
  private getEffectiveMessage(message: string): string {
    return this.extractOverrideMessage(message) || message;
  }

  /**
   * Message used for feature-flag evaluation, preferring PR override when available.
   */
  private getFeatureFlagMessage(commit: Commit): string {
    if (commit.pullRequest?.body) {
      const overrideFromPr = this.extractOverrideMessage(
        commit.pullRequest.body
      );
      if (overrideFromPr) {
        return overrideFromPr;
      }
    }

    return this.getEffectiveMessage(commit.message);
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
