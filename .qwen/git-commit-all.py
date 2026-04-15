#!/usr/bin/env python3
import os
import subprocess

repo_dir = '/Users/mihaiperdum/Projects/mcp-web-search-upd/mcp-web-search'

print(f"Working directory: {repo_dir}")

# Step 1: Check git status
print("\n=== Checking git status ===")
try:
    result = subprocess.run(['git', 'status'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    print("Output:", result.stdout[:1000])
except Exception as e:
    print(f"Error: {e}")

# Step 2: Add ALL changes
print("\n=== Adding all changes ===")
try:
    result = subprocess.run(['git', 'add', '.'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:500])
    if result.stderr:
        print("STDERR:", result.stderr[:500])
except Exception as e:
    print(f"Error running git add: {e}")

# Step 3: Check what will be committed
print("\n=== Checking staged changes ===")
try:
    result = subprocess.run(['git', 'diff', '--cached', '--name-only'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    print("Staged files:")
    if result.stdout:
        for line in result.stdout.strip().split('\n'):
            print(f"  {line}")
except Exception as e:
    print(f"Error: {e}")

# Step 4: Commit
print("\n=== Committing changes ===")
try:
    commit_msg = "chore: update dependencies and various source files"
    result = subprocess.run(['git', 'commit', '-m', commit_msg], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:500])
    if result.stderr:
        print("STDERR:", result.stderr[:500])
except Exception as e:
    print(f"Error running git commit: {e}")

# Step 5: Push
print("\n=== Pushing to remote ===")
try:
    result = subprocess.run(['git', 'push', 'origin', 'main'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:500])
    if result.stderr:
        print("STDERR:", result.stderr[:500])
except Exception as e:
    print(f"Error running git push: {e}")

print("\n=== Done ===")
