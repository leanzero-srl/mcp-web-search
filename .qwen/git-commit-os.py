#!/usr/bin/env python3
import os

repo_dir = '/Users/mihaiperdum/Projects/mcp-web-search-upd/mcp-web-search'
os.chdir(repo_dir)

print(f"Working directory: {os.getcwd()}")

# Step 1: Check git status
print("\n=== Checking git status ===")
exit_code = os.system('git status --porcelain')
print("Exit code:", exit_code)

# Step 2: Add file
print("\n=== Adding openapi-extractor.ts ===")
exit_code = os.system('git add src/openapi-extractor.ts')
print("Exit code:", exit_code)

# Step 3: Commit
print("\n=== Committing changes ===")
commit_msg = "fix: Add URL validation before fetching in OpenAPI extractor\n\n- Validates URL format using new URL() constructor\n- Returns early with clear error message for invalid URLs\n- Prevents network errors from malformed URLs"
exit_code = os.system(f'git commit -m "{commit_msg}"')
print("Exit code:", exit_code)

# Step 4: Push
print("\n=== Pushing to remote ===")
exit_code = os.system('git push origin main')
print("Exit code:", exit_code)

print("\n=== Done ===")
