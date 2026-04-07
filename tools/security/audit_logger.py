#!/usr/bin/env python3
"""
Audit Logger - Log all external actions for accountability.
"""

import json
import datetime
import os
from pathlib import Path

LOG_FILE = Path(__file__).parent / 'audit_log.jsonl'


def log_action(action, target, summary, approved_by=None, metadata=None):
    """
    Log an external action.
    
    Args:
        action: Type of action (send_email, post_tweet, api_call, etc.)
        target: Recipient/target of the action
        summary: Brief description
        approved_by: Who approved this action (None if autonomous)
        metadata: Additional context (dict)
    """
    entry = {
        'timestamp': datetime.datetime.now().isoformat(),
        'action': action,
        'target': target,
        'summary': summary,
        'approved_by': approved_by,
        'metadata': metadata or {}
    }
    
    with open(LOG_FILE, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    
    return entry


def get_recent_actions(hours=24):
    """Get actions from the last N hours."""
    if not LOG_FILE.exists():
        return []
    
    cutoff = datetime.datetime.now() - datetime.timedelta(hours=hours)
    actions = []
    
    with open(LOG_FILE, 'r') as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                entry_time = datetime.datetime.fromisoformat(entry['timestamp'])
                if entry_time >= cutoff:
                    actions.append(entry)
            except (json.JSONDecodeError, KeyError):
                continue
    
    return actions


def print_summary(hours=24):
    """Print a summary of recent actions."""
    actions = get_recent_actions(hours)
    
    print(f"Recent actions (last {hours} hours):")
    print(f"Total: {len(actions)}\n")
    
    for action in actions:
        print(f"  {action['timestamp'][:19]} | {action['action']}")
        print(f"    Target: {action['target']}")
        print(f"    Summary: {action['summary']}")
        if action['approved_by']:
            print(f"    Approved by: {action['approved_by']}")
        print()


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Audit log viewer')
    parser.add_argument('--hours', type=int, default=24, help='Hours to look back')
    args = parser.parse_args()
    
    print_summary(args.hours)
