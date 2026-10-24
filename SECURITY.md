# Security Policy

## Supported Versions

Silence is a continuously deployed website, not a versioned package. There are no release branches. Only the current `main` branch (what is live on the site) receives security fixes.

| Version                    | Supported          |
| -------------------------- | ------------------ |
| `main` (live site)         | :white_check_mark: |
| Forks and older commits    | :x:                |

If you run your own copy, pull the latest `main` to get fixes.

## Reporting a Vulnerability

**Please do not open a public issue, post in the site chat, or use the forms page for security problems.** Those are all public or read by moderators.

Report privately through GitHub:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe what you found.

Helpful details:

- What the issue is and where it is (page, API route, or file)
- Steps to reproduce, or a proof of concept
- What an attacker could do with it
- Your browser and OS, if it is browser-specific

### What to expect

- **Acknowledgement:** within 7 days.
- **Updates:** at least every 14 days until it is resolved.
- **If accepted:** we will confirm the issue, work on a fix, and deploy it. We will tell you when it is live, and credit you in the fix or release notes if you want that.
- **If declined:** we will explain why, for example if it is working as intended or cannot be exploited.

Please give us a reasonable chance to fix the issue before disclosing it publicly.

### In scope

- The Worker API (`worker.js`): forms, admin, AI proxy, and chat (sessions, rooms, files, moderation)
- Authentication and authorization, including chat staff accounts and the admin token
- Cross-site scripting, injection, or ways to read or change other people's data
- Secrets or private data exposed to the browser
- The site shell and pages in this repository

### Out of scope

- The games themselves. They are third-party content served from a separate storage bucket, so report problems with a game to its original authors.
- Third-party ad scripts and services
- Spam, rate-limit exhaustion, or denial-of-service through sheer volume
- Reports that need physical access to a device, or a browser or extension that is already compromised
- Missing security headers or best-practice suggestions with no demonstrable impact

Thank you for helping keep Silence and its users safe.
