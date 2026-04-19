#!/usr/bin/env node
/**
 * Cascade Drift Detector
 * Checks for conflicting changes between parallel agent executions.
 * Run between GSD waves to catch drift before it compounds.
 *
 * Usage:
 *   node drift-detector.cjs check           # Check for drift since last checkpoint
 *   node drift-detector.cjs checkpoint      # Set a checkpoint (before spawning agents)
 *   node drift-detector.cjs report          # Full drift report
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, '.cascade', 'drift');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'last-checkpoint.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    return '';
  }
}

const commands = {
  /**
   * Set a checkpoint before spawning parallel agents.
   * Records the current HEAD commit and file state.
   */
  checkpoint: () => {
    ensureDir(DATA_DIR);
    const head = git('rev-parse HEAD');
    const status = git('status --porcelain');
    const checkpoint = {
      commit: head,
      timestamp: new Date().toISOString(),
      dirtyFiles: status ? status.split('\n').map(l => l.trim()) : [],
    };
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf-8');
    console.log(`[CASCADE DRIFT] Checkpoint set at ${head.substring(0, 8)}`);
    return checkpoint;
  },

  /**
   * Check for drift since last checkpoint.
   * Detects: conflicting file edits, unexpected modifications, large diffs.
   */
  check: () => {
    if (!fs.existsSync(CHECKPOINT_FILE)) {
      console.log('[CASCADE DRIFT] No checkpoint found. Run "checkpoint" first.');
      return null;
    }

    const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    const head = git('rev-parse HEAD');

    if (head === checkpoint.commit) {
      console.log('[CASCADE DRIFT] No new commits since checkpoint.');
      return { drift: false, commits: 0 };
    }

    // Get commits since checkpoint
    const log = git(`log --oneline ${checkpoint.commit}..HEAD`);
    const commits = log ? log.split('\n').filter(Boolean) : [];

    // Get all files changed since checkpoint
    const diffFiles = git(`diff --name-only ${checkpoint.commit}..HEAD`);
    const changedFiles = diffFiles ? diffFiles.split('\n').filter(Boolean) : [];

    // Detect conflicts: files touched by multiple commits
    const fileCommitMap = {};
    for (const commit of commits) {
      const sha = commit.split(' ')[0];
      const files = git(`diff-tree --no-commit-id --name-only -r ${sha}`);
      if (files) {
        for (const file of files.split('\n').filter(Boolean)) {
          if (!fileCommitMap[file]) fileCommitMap[file] = [];
          fileCommitMap[file].push(sha);
        }
      }
    }

    const conflicts = {};
    for (const [file, shas] of Object.entries(fileCommitMap)) {
      if (shas.length > 1) {
        conflicts[file] = shas;
      }
    }

    const conflictCount = Object.keys(conflicts).length;
    const hasDrift = conflictCount > 0;

    // Get diff stats
    const stat = git(`diff --stat ${checkpoint.commit}..HEAD`);

    const result = {
      drift: hasDrift,
      commits: commits.length,
      filesChanged: changedFiles.length,
      conflicts: conflictCount,
      conflictDetails: conflicts,
      since: checkpoint.commit.substring(0, 8),
      current: head.substring(0, 8),
    };

    if (hasDrift) {
      console.log(`[CASCADE DRIFT] WARNING: ${conflictCount} file(s) modified by multiple agents:`);
      for (const [file, shas] of Object.entries(conflicts)) {
        console.log(`  - ${file} (${shas.length} commits: ${shas.map(s => s.substring(0, 7)).join(', ')})`);
      }
      console.log(`\nReview with: git diff ${checkpoint.commit.substring(0, 8)}..HEAD -- <file>`);
    } else {
      console.log(`[CASCADE DRIFT] Clean: ${commits.length} commits, ${changedFiles.length} files changed, no conflicts.`);
    }

    return result;
  },

  /**
   * Full drift report with recommendations.
   */
  report: () => {
    const result = commands.check();
    if (!result) return;

    if (result.drift) {
      console.log('\n--- Drift Report ---');
      console.log(`Commits since checkpoint: ${result.commits}`);
      console.log(`Files changed: ${result.filesChanged}`);
      console.log(`Conflict files: ${result.conflicts}`);
      console.log('\nRecommendations:');
      console.log('  1. Review conflicting files for inconsistencies');
      console.log('  2. Run tests to verify nothing broke');
      console.log('  3. Consider running agents sequentially for overlapping files');
    } else {
      console.log('\n[CASCADE DRIFT] No drift detected. Safe to continue.');
    }
  },
};

module.exports = commands;

if (require.main === module) {
  const [,, command] = process.argv;
  if (command && commands[command]) {
    commands[command]();
  } else {
    console.log('Usage: drift-detector.cjs <checkpoint|check|report>');
  }
}
