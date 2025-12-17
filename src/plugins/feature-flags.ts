import { Commit } from '../commit';
import { execSync } from 'child_process';
import { ManifestPlugin } from '../plugin';

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
            `[FeatureFlagPlugin] Initialized with enabled flags: ${Array.from(this.enabledFlags).join(', ') || 'none'
            }`
        );
    }

    /**
     * Filter commits based on feature flags before they're used for changelog generation
     */
    async preconfigure(
        strategiesByPath: Record<string, any>,
        commitsByPath: Record<string, Commit[]>,
        releasesByPath: Record<string, any>
    ): Promise<Record<string, any>> {
        // Find newly enabled flags (enabled now but weren't before)
        const newlyEnabledFlags = Array.from(this.enabledFlags).filter(
            flag => !this.previouslyEnabledFlags.has(flag)
        );

        // Filter commits for each path
        const filteredCommitsByPath: Record<string, Commit[]> = {};

        for (const [path, commits] of Object.entries(commitsByPath)) {
            const filteredCommits = commits.filter(commit => {
                return this.shouldIncludeCommit(commit);
            });

            // If any flags were newly enabled, find their historical commits
            if (newlyEnabledFlags.length > 0) {
                console.log(
                    `[FeatureFlagPlugin] Newly enabled flags: ${newlyEnabledFlags.join(
                        ', '
                    )}`
                );
                const historicalCommits = this.findHistoricalCommits(newlyEnabledFlags);

                // Add historical commits, avoiding duplicates
                const existingShas = new Set(filteredCommits.map(c => c.sha));
                for (const commit of historicalCommits) {
                    if (!existingShas.has(commit.sha)) {
                        filteredCommits.push(commit);
                    }
                }
            }

            filteredCommitsByPath[path] = filteredCommits;
        }

        // Return strategies with filtered commits injected
        // The release-please API expects us to return updated strategies
        const updatedStrategies: Record<string, any> = {};
        for (const [path, strategy] of Object.entries(strategiesByPath)) {
            updatedStrategies[path] = strategy;
            // Inject filtered commits into the strategy if possible
            if (strategy && typeof strategy === 'object') {
                (strategy as any)._commits = filteredCommitsByPath[path] || [];
            }
        }

        return updatedStrategies;
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
                    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
                );

                if (output.trim()) {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        const [sha, subject, body, authorName, authorEmail] =
                            line.split('|');

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
