#!/usr/bin/env python3
import subprocess
import sys

# Change to the repository directory
repo_dir = '/Users/mihaiperdum/Projects/mcp-web-search-upd/mcp-web-search'

print(f"Working directory: {repo_dir}")

# Step 1: Check git status
print("\n=== Checking git status ===")
try:
    result = subprocess.run(['git', 'status'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    print("STDOUT:", result.stdout[:500])
    if result.stderr:
        print("STDERR:", result.stderr[:200])
except Exception as e:
    print(f"Error running git status: {e}")

# Step 2: Add file
print("\n=== Adding openapi-extractor.ts ===")
try:
    result = subprocess.run(['git', 'add', 'src/openapi-extractor.ts'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:200])
    if result.stderr:
        print("STDERR:", result.stderr[:200])
except Exception as e:
    print(f"Error running git add: {e}")

# Step 3: Commit
print("\n=== Committing changes ===")
try:
    commit_msg = "fix: Add URL validation before fetching in OpenAPI extractor\n\n- Validates URL format using new URL() constructor\n- Returns early with clear error message for invalid URLs\n- Prevents network errors from malformed URLs"
    result = subprocess.run(['git', 'commit', '-m', commit_msg], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:200])
    if result.stderr:
        print("STDERR:", result.stderr[:200])
except Exception as e:
    print(f"Error running git commit: {e}")

# Step 4: Push
print("\n=== Pushing to remote ===")
try:
    result = subprocess.run(['git', 'push', 'origin', 'main'], cwd=repo_dir, capture_output=True, text=True)
    print("Return code:", result.returncode)
    if result.stdout:
        print("STDOUT:", result.stdout[:200])
    if result.stderr:
        print("STDERR:", result.stderr[:200])
except Exception as e:
    print(f"Error running git push: {e}")

print("\n=== Done ===")
