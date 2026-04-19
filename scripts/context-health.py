#!/usr/bin/env python3
"""Check context window health for the current Claude Code session.

Reads Claude Code session JSONL files and extracts exact token counts
from API usage data. No external dependencies — stdlib only.

Usage:
    # Auto-detect current session (finds most recent JSONL)
    python3 scripts/context-health.py

    # Specific session file
    python3 scripts/context-health.py --session path/to/session.jsonl

    # Custom context limit (default: 1,000,000 for Opus)
    python3 scripts/context-health.py --limit 200000

    # JSON output for programmatic use
    python3 scripts/context-health.py --json
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone


def find_latest_session():
    """Find the most recently modified session JSONL in the Claude projects dir."""
    claude_projects = os.path.expanduser("~/.claude/projects")
    if not os.path.isdir(claude_projects):
        return None

    jsonl_files = glob.glob(os.path.join(claude_projects, "**", "*.jsonl"), recursive=True)
    if not jsonl_files:
        return None

    return max(jsonl_files, key=os.path.getmtime)


def extract_usage(path):
    """Extract token counts from the last assistant turn's usage data."""
    last_usage = None
    turn_count = 0

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") == "assistant":
                turn_count += 1
                msg = record.get("message")
                if isinstance(msg, dict) and "usage" in msg:
                    last_usage = msg["usage"]

    if last_usage is None:
        return None

    input_tokens = last_usage.get("input_tokens", 0)
    cache_creation = last_usage.get("cache_creation_input_tokens", 0)
    cache_read = last_usage.get("cache_read_input_tokens", 0)
    output_tokens = last_usage.get("output_tokens", 0)

    return {
        "input_tokens": input_tokens,
        "cache_creation": cache_creation,
        "cache_read": cache_read,
        "output_tokens": output_tokens,
        "total_context": input_tokens + cache_creation + cache_read,
        "turns": turn_count,
    }


def health_status(pct_remaining):
    """Map remaining capacity to status."""
    if pct_remaining >= 75:
        return "GREEN", "Operating normally"
    if pct_remaining >= 60:
        return "AMBER", "Monitor closely — avoid large new tasks"
    if pct_remaining >= 40:
        return "RED", "Consider saving state and starting fresh"
    return "CRITICAL", "Save work immediately — context exhaustion imminent"


def main():
    parser = argparse.ArgumentParser(description="Check Claude Code context window health.")
    parser.add_argument("--session", help="Path to session JSONL file (auto-detects if omitted)")
    parser.add_argument("--limit", type=int, default=1_000_000, help="Context window token limit (default: 1000000)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    path = args.session or find_latest_session()
    if not path:
        print("No session file found.", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(path):
        print(f"File not found: {path}", file=sys.stderr)
        sys.exit(1)

    usage = extract_usage(path)
    if usage is None:
        print("No usage data found in session.", file=sys.stderr)
        sys.exit(1)

    total = usage["total_context"]
    remaining = max(args.limit - total, 0)
    pct = int((remaining / args.limit) * 100) if args.limit > 0 else 0
    status, action = health_status(pct)

    if args.json:
        report = {
            "session": os.path.basename(path),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "token_limit": args.limit,
            "tokens_used": total,
            "tokens_remaining": remaining,
            "pct_remaining": pct,
            "status": status,
            "action": action,
            "turns": usage["turns"],
            "breakdown": {
                "input": usage["input_tokens"],
                "cache_creation": usage["cache_creation"],
                "cache_read": usage["cache_read"],
                "output": usage["output_tokens"],
            },
        }
        print(json.dumps(report, indent=2))
    else:
        bar_width = 30
        filled = int((pct / 100) * bar_width)
        bar = "█" * filled + "░" * (bar_width - filled)

        print(f"\n  Context Health: {status}")
        print(f"  [{bar}] {pct}% remaining")
        print(f"  {total:,} / {args.limit:,} tokens used ({usage['turns']} turns)")
        print(f"  → {action}\n")


if __name__ == "__main__":
    main()
