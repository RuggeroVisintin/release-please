"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.factory = exports.FeatureFlagPlugin = void 0;
const child_process_1 = require("child_process");
const plugin_1 = require("../plugin");
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
class FeatureFlagPlugin extends plugin_1.ManifestPlugin {
    constructor(github, targetBranch, repositoryConfig) {
        super(github, targetBranch, repositoryConfig);
        // Build set of enabled flags from environment variables only
        this.enabledFlags = new Set();
        this.previouslyEnabledFlags = new Set();
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
        console.log(`[FeatureFlagPlugin] Initialized with enabled flags: ${Array.from(this.enabledFlags).join(', ') || 'none'}`);
    }
    /**
     * Process commits to filter based on feature flags
     */
    processCommits(commits) {
        const filtered = commits.filter(commit => {
            return this.shouldIncludeCommit(commit);
        });
        console.log(`[FeatureFlagPlugin] Filtered ${commits.length} commits down to ${filtered.length}`);
        return filtered;
    }
    /**
     * Find historical commits for newly enabled flags
     */
    findHistoricalCommits(flags) {
        const commits = [];
        for (const flag of flags) {
            try {
                // Search for all commits mentioning this feature flag
                const grepPattern = `Feature-Flag: ${flag}`;
                const output = (0, child_process_1.execSync)(`git log --all --grep="${grepPattern}" --format="%H|%s|%b|%an|%ae"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
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
                            files: [],
                            type: this.extractCommitType(subject),
                            scope: this.extractCommitScope(subject),
                            bareMessage: subject,
                            notes: [],
                            references: [],
                            breaking: false,
                        });
                        console.log(`[FeatureFlagPlugin] Found historical commit ${sha.substring(0, 7)} for ${flag}`);
                    }
                }
            }
            catch (error) {
                console.error(`[FeatureFlagPlugin] Error finding commits for ${flag}:`, error);
            }
        }
        return commits;
    }
    /**
     * Extract commit type from conventional commit message (feat, fix, etc.)
     */
    extractCommitType(message) {
        const match = message.match(/^(\w+)(?:\([\w-]+\))?:/);
        return match ? match[1] : undefined;
    }
    /**
     * Extract commit scope from conventional commit message
     */
    extractCommitScope(message) {
        const match = message.match(/^\w+\(([\w-]+)\):/);
        return match ? match[1] : undefined;
    }
    /**
     * Determine if a commit should be included based on its feature flag
     */
    shouldIncludeCommit(commit) {
        var _a;
        // Extract feature flag from commit message
        const flagMatch = commit.message.match(/Feature-Flag:\s*(\w+)/i);
        if (!flagMatch) {
            // No feature flag = always include
            return true;
        }
        const flag = flagMatch[1];
        const isEnabled = this.enabledFlags.has(flag);
        console.log(`[FeatureFlagPlugin] Commit ${(_a = commit.sha) === null || _a === void 0 ? void 0 : _a.substring(0, 7)}: Feature-Flag=${flag}, enabled=${isEnabled}`);
        return isEnabled;
    }
}
exports.FeatureFlagPlugin = FeatureFlagPlugin;
// Export factory function for release-please to load the plugin
function factory(github, targetBranch, repositoryConfig) {
    return new FeatureFlagPlugin(github, targetBranch, repositoryConfig);
}
exports.factory = factory;
//# sourceMappingURL=feature-flags.js.map