#!/usr/bin/env python3
"""
Outbound Filter - Scan text for secrets before sending externally.
"""

import re
import sys
import argparse

# Patterns to detect
PATTERNS = {
    'api_key': [
        r'api[_-]?key["\']?\s*[:=]\s*["\']?[a-zA-Z0-9]{16,}["\']?',
        r'apikey["\']?\s*[:=]\s*["\']?[a-zA-Z0-9]{16,}["\']?',
    ],
    'aws_key': [
        r'AKIA[0-9A-Z]{16}',
        r'aws[_-]?secret[_-]?access[_-]?key["\']?\s*[:=]\s*["\']?[a-zA-Z0-9/+=]{40}["\']?',
    ],
    'private_key': [
        r'-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----',
        r'-----BEGIN (RSA |DSA |EC |OPENSSH )?ENCRYPTED PRIVATE KEY-----',
    ],
    'token': [
        r'auth[_-]?token["\']?\s*[:=]\s*["\']?[a-zA-Z0-9\-_]{20,}["\']?',
        r'bearer\s+[a-zA-Z0-9\-_]{20,}',
        r'token["\']?\s*[:=]\s*["\']?[a-zA-Z0-9\-_]{32,}["\']?',
    ],
    'password_in_url': [
        r'[a-z]+://[^/\s:]+:[^/\s@]+@[^/\s]+',
    ],
    'github_token': [
        r'gh[pousr]_[A-Za-z0-9_]{36,}',
    ],
    'slack_token': [
        r'xox[baprs]-[0-9a-zA-Z-]+',
    ],
}


def scan_text(text):
    """Scan text for potential secrets."""
    findings = []
    
    for category, patterns in PATTERNS.items():
        for pattern in patterns:
            matches = re.finditer(pattern, text, re.IGNORECASE)
            for match in matches:
                # Mask the actual secret in output
                matched_text = match.group()
                masked = matched_text[:8] + '***' + matched_text[-4:] if len(matched_text) > 12 else '***'
                findings.append({
                    'category': category,
                    'pattern': pattern[:50] + '...' if len(pattern) > 50 else pattern,
                    'matched': masked,
                    'position': match.span()
                })
    
    return findings


def main():
    parser = argparse.ArgumentParser(description='Scan text for secrets before outbound sending')
    parser.add_argument('--check', type=str, help='Text to check')
    parser.add_argument('--file', type=str, help='File to check')
    args = parser.parse_args()
    
    if args.check:
        text = args.check
    elif args.file:
        with open(args.file, 'r') as f:
            text = f.read()
    else:
        text = sys.stdin.read()
    
    findings = scan_text(text)
    
    if findings:
        print("⚠️  POTENTIAL SECRETS DETECTED!")
        print(f"Found {len(findings)} potential secret(s):\n")
        
        for finding in findings:
            print(f"  Category: {finding['category']}")
            print(f"  Matched:  {finding['matched']}")
            print(f"  Position: {finding['position']}")
            print()
        
        print("❌ DO NOT SEND - Review and remove secrets first")
        sys.exit(1)
    else:
        print("✅ No secrets detected")
        sys.exit(0)


if __name__ == '__main__':
    main()
