// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {describe, it, beforeEach, afterEach} from 'mocha';
import * as assert from 'assert';
import {FeatureFlagPlugin} from '../../src/plugins/feature-flags';
import {Commit} from '../../src/commit';

describe('FeatureFlagPlugin', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = {...process.env};
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('commit filtering', () => {
    it('should filter out commits with disabled feature flags', async () => {
      // Set up environment with one enabled flag
      process.env.FEATURE_TEST_ENABLED = 'true';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc123',
          message: 'feat: enabled feature\n\nFeature-Flag: FEATURE_TEST_ENABLED',
          files: [],
        } as Commit,
        {
          sha: 'def456',
          message: 'feat: disabled feature\n\nFeature-Flag: FEATURE_TEST_DISABLED',
          files: [],
        } as Commit,
        {
          sha: 'ghi789',
          message: 'feat: no flag',
          files: [],
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      assert.strictEqual(commitsByPath['.'].length, 2);
      assert.strictEqual(commitsByPath['.'][0].sha, 'abc123');
      assert.strictEqual(commitsByPath['.'][1].sha, 'ghi789');
    });

    it('should include commits without feature flags', async () => {
      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc123',
          message: 'feat: regular commit',
          files: [],
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      assert.strictEqual(commitsByPath['.'].length, 1);
    });

    it('should handle multiple paths independently', async () => {
      process.env.FEATURE_PATH_A = 'true';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commitsByPath = {
        'path-a': [
          {
            sha: 'abc',
            message: 'feat: path a\n\nFeature-Flag: FEATURE_PATH_A',
            files: [],
          } as Commit,
        ],
        'path-b': [
          {
            sha: 'def',
            message: 'feat: path b\n\nFeature-Flag: FEATURE_PATH_B',
            files: [],
          } as Commit,
        ],
      };

      await plugin.preconfigure({}, commitsByPath, {});

      assert.strictEqual(commitsByPath['path-a'].length, 1);
      assert.strictEqual(commitsByPath['path-b'].length, 0);
    });

    it('should be case-insensitive for Feature-Flag header', async () => {
      process.env.FEATURE_TEST = 'true';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc',
          message: 'feat: lowercase\n\nfeature-flag: FEATURE_TEST',
          files: [],
        } as Commit,
        {
          sha: 'def',
          message: 'feat: uppercase\n\nFEATURE-FLAG: FEATURE_TEST',
          files: [],
        } as Commit,
        {
          sha: 'ghi',
          message: 'feat: mixed\n\nFeature-Flag: FEATURE_TEST',
          files: [],
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      assert.strictEqual(commitsByPath['.'].length, 3);
    });
    it('should respect feature flags in PR commit overrides', async () => {
      process.env.FEATURE_ENABLED = 'true';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc',
          message: 'Regular commit message',
          files: [],
          pullRequest: {
            body: `Some PR description

BEGIN_COMMIT_OVERRIDE
feat: override with enabled flag

Feature-Flag: FEATURE_ENABLED
END_COMMIT_OVERRIDE`,
          } as any,
        } as Commit,
        {
          sha: 'def',
          message: 'Another commit',
          files: [],
          pullRequest: {
            body: `BEGIN_COMMIT_OVERRIDE
feat: override with disabled flag

Feature-Flag: FEATURE_DISABLED
END_COMMIT_OVERRIDE`,
          } as any,
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      // Should keep enabled, filter disabled
      assert.strictEqual(commitsByPath['.'].length, 1);
      assert.strictEqual(commitsByPath['.'][0].sha, 'abc');
    });  });

  describe('environment variable handling', () => {
    it('should only load FEATURE_* environment variables', async () => {
      process.env.FEATURE_ENABLED = 'true';
      process.env.NOT_A_FEATURE = 'true';
      process.env.RANDOM_VAR = 'true';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc',
          message: 'feat: test\n\nFeature-Flag: NOT_A_FEATURE',
          files: [],
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      // NOT_A_FEATURE should be filtered because it's not enabled
      assert.strictEqual(commitsByPath['.'].length, 0);
    });

    it('should only enable flags with value "true"', async () => {
      process.env.FEATURE_TRUE = 'true';
      process.env.FEATURE_FALSE = 'false';
      process.env.FEATURE_OTHER = 'yes';

      const plugin = new FeatureFlagPlugin({} as any, 'main', {});

      const commits: Commit[] = [
        {
          sha: 'abc',
          message: 'feat: true\n\nFeature-Flag: FEATURE_TRUE',
          files: [],
        } as Commit,
        {
          sha: 'def',
          message: 'feat: false\n\nFeature-Flag: FEATURE_FALSE',
          files: [],
        } as Commit,
        {
          sha: 'ghi',
          message: 'feat: other\n\nFeature-Flag: FEATURE_OTHER',
          files: [],
        } as Commit,
      ];

      const commitsByPath = {'.': commits};
      await plugin.preconfigure({}, commitsByPath, {});

      // Only FEATURE_TRUE should be included
      assert.strictEqual(commitsByPath['.'].length, 1);
      assert.strictEqual(commitsByPath['.'][0].sha, 'abc');
    });
  });
});
