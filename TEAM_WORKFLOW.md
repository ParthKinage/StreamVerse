# TESOR_GP - Team Collaboration & Git Workflow Guide

Welcome to the **TESOR_GP** project repository! This guide defines the workflow for our 4-member team to work concurrently, manage branch isolation, prevent merge conflicts, and push verified changes to GitHub.

---

## 1. Repository Access & Setup

Before starting, the repository owner must invite all team members, and members must accept the invitation:

### Owner Instructions (Add Collaborators)
1. Go to the repo page: `https://github.com/Achira621/Tesor_gp`
2. Click **Settings** (top navigation bar) -> **Collaborators** (left sidebar).
3. Click **Add people** and enter the team member's GitHub username.
4. Send the invitation.

### Member Instructions (Accept Invitation)
1. Check your email for the GitHub invitation or visit: `https://github.com/Achira621/Tesor_gp/invitations`
2. Accept the invitation to gain push permissions to the repository.

---

## 2. Team Ownership Matrix

Each member has primary responsibility over specific modules in the monorepo. Replace the `@username` placeholders with your actual GitHub accounts:

| Role / Owner | Domain & Directories | Assigned Branch | Primary Responsibilities |
|---|---|---|---|
| **Member 1** (`@username`) | `apps/web` | `feature/frontend` | Streaming UI, React components, Video player, Wallet integration, Dashboards |
| **Member 2** (`@username`) | `apps/api`, `packages/database` | `feature/backend-api` | Express API Gateway, Watch-Time heartbeat validation, Auth, PostgreSQL/Prisma schemas |
| **Member 3** (`@username`) | `contracts/`, `packages/blockchain` | `feature/blockchain` | Polygon Amoy Smart Contracts (StreamCoin, Payment Router), Blockchain Adapter SDK |
| **Member 4** (`@username`) | `workers/`, `ai/` | `feature/media-ai` | FFmpeg video transcoding to HLS, AI Recommendation Service & Fallbacks |

---

## 3. Branch Hierarchy


```text
main           ───────► Stable Production Branch (Protected)
  ▲
  │ (Pull Request)
develop        ───────► Integration Testing Branch
  ▲
  ├── feature/frontend     ──────► Member 1 Work
  ├── feature/backend-api  ──────► Member 2 Work
  ├── feature/blockchain   ──────► Member 3 Work
  └── feature/media-ai     ──────► Member 4 Work
```

---

## 3. Step-by-Step Developer Guide

### Initial Setup (For Each Member)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Achira621/Tesor_gp.git
   cd Tesor_gp
   ```

2. **Fetch all remote branches:**
   ```bash
   git fetch origin
   ```

3. **Switch to your assigned feature branch:**

   * **Member 1 (Frontend):**
     ```bash
     git checkout feature/frontend
     ```

   * **Member 2 (Backend & DB):**
     ```bash
     git checkout feature/backend-api
     ```

   * **Member 3 (Blockchain & Contracts):**
     ```bash
     git checkout feature/blockchain
     ```

   * **Member 4 (Media & AI Workers):**
     ```bash
     git checkout feature/media-ai
     ```


---

### Local Project Setup & Installation

After checking out your feature branch, follow these steps to set up your local development environment:

#### 1. Install Prerequisites
Ensure you have the following installed on your machine:
- **Node.js** (v18 or higher)
- **PostgreSQL** (running locally or a remote connection string)
- **Redis** (running locally on default port 6379, or config URI)
- **FFmpeg** (installed and added to your system PATH)

#### 2. Install Project Dependencies
Run the following command at the root directory of the repository to install all packages and link the monorepo workspaces:
```bash
npm install
```

#### 3. Set Up Environment Variables
1. Duplicate the `.env.example` file in the root directory:
   ```bash
   copy .env.example .env
   ```
2. Open the new `.env` file and configure your PostgreSQL database connection (`DATABASE_URL`) and other local settings.

#### 4. Initialize Database Schemas
Generate the Prisma Client and apply database tables to your PostgreSQL database:
```bash
npm run prisma:generate --workspace=@tesor_gp/database
npm run prisma:migrate --workspace=@tesor_gp/database
```

#### 5. Build Shared Libraries
Build the core shared packages (`@tesor_gp/shared`, `@tesor_gp/blockchain`, `@tesor_gp/database`) so your applications can consume them:
```bash
npm run build:packages
```

#### 6. Start the Local Servers
To run the Web application and backend APIs simultaneously in development mode, run:
```bash
npm run dev
```
- **Web Interface:** Access at [http://localhost:3000](http://localhost:3000)
- **API Server:** Health endpoint at [http://localhost:4000/health](http://localhost:4000/health)

---


### Daily Development & Pushing Work

1. **Pull latest changes from `develop` before starting work:**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout <your-assigned-branch>
   git merge develop
   ```

2. **Work inside your assigned workspace directory** (e.g., Member 1 works in `apps/web`).

3. **Commit your changes:**
   ```bash
   git add .
   git commit -m "feat(module): descriptive summary of changes"
   ```

4. **Push to your feature branch:**
   ```bash
   git push origin <your-assigned-branch>
   ```

---

## 4. Merging Your Code (Pull Request Workflow)

When your feature or update is tested and ready:

1. **Go to GitHub Repository:** `https://github.com/Achira621/Tesor_gp`
2. **Open a Pull Request (PR):**
   - **Base:** `develop`
   - **Compare:** `<your-assigned-branch>` (e.g., `feature/frontend`)
3. **Review & CI Check:**
   - The automated GitHub Action CI will run `npm run build` and `npm run test`.
   - Ensure all checks pass.
4. **Merge into `develop`:**
   - Once approved, merge the PR into `develop`.
5. **Production Release:**
   - Once all 4 members' work on `develop` is verified together, open a PR from `develop` into `main`.

---

## 5. Guidelines to Avoid Conflicts

* **Do not edit files outside your assigned module** unless coordinating with the owner of that module.
* **Shared Types:** Any changes to `packages/shared/` affect everyone. Announce shared interface changes to the team.
* **Never push directly to `main` or `develop`.** Always push to your feature branch and use Pull Requests.
