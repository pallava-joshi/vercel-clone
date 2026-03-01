# Testing & Deployment Guide

Complete walkthrough to set up AWS infrastructure, configure every service, and test the Vercel Clone end-to-end.

---

## Prerequisites


| Tool    | Minimum Version | Purpose                           | Required?                                  |
| ------- | --------------- | --------------------------------- | ------------------------------------------ |
| Node.js | 20.9+           | All services                      | ✅ Yes                                     |
| npm     | 10+             | Dependency management             | ✅ Yes                                     |
| Docker  | 24+             | Building the `build-server` image | ✅ Yes                                     |
| Redis   | 7+              | Log pub/sub between services      | ✅ Yes                                     |
| Git     | 2.x             | Cloning repos inside container    | ✅ Yes                                     |
| AWS CLI | 2.x             | ECR login, pushing Docker images  | ❌ Optional (use AWS Console push commands instead) |


---

## 1. AWS Setup

### A. Create an IAM User

1. Go to **AWS Console** > **IAM** > **Users** > **Create user**.
2. User name: `vercel-clone-user`.
3. **Attach policies directly** — add these managed policies:
  - `AmazonS3FullAccess`
  - `AmazonECS_FullAccess`
  - `AmazonEC2ContainerRegistryFullAccess`
4. Click **Next** > **Create user**.
5. Click the user > **Security credentials** > **Create access key** > choose **Local code**.
6. **Download the** `.csv` or copy:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`

> Keep these safe. You will use them in the `api-server` and `build-server` environment configuration AND in the AWS CLI.

### A2. Add `iam:PassRole` Permission (Required for ECS)

**Why this is needed**: When the `api-server` calls `RunTaskCommand`, ECS needs to assume a "task execution role" to pull the Docker image from ECR and write logs to CloudWatch. Your IAM user must have permission to "pass" this role to ECS.

**Step-by-step:**

1. Go back to **IAM** > **Users** > click `vercel-clone-user`.
2. Click the **Permissions** tab.
3. Click **Add permissions** dropdown > **Create inline policy**.
4. Click the **JSON** tab (not the visual editor).
5. Delete the default JSON and paste this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/ecsTaskExecutionRole"
    }
  ]
}
```

6. Click **Next**.
7. Policy name: `ECSPassRolePolicy`.
8. Click **Create policy**.

**Alternative (simpler but less secure for testing):**

If you want to allow passing any role (useful during development), use:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/*"
    }
  ]
}
```

> **Note**: If you're using a custom task execution role name (not the default `ecsTaskExecutionRole`), replace it in the `Resource` ARN above.

### B. Create S3 Bucket

1. Go to **S3** > **Create bucket**.
2. Bucket name: `vercel-clone-outputs`.
3. Region: same as you'll use for ECS (e.g. `ap-south-1`).
4. **Uncheck** "Block all public access" and acknowledge the warning.
5. After creation, go to **Permissions** > **Bucket policy** and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::vercel-clone-outputs/*"
    }
  ]
}
```

> Replace `vercel-clone-outputs` if you chose a different name.

### C. Create ECR Repository

1. Go to **ECR** > **Create repository**.
2. Repository name: `build-server`.
3. Visibility: **Private**.
4. After creation, click the repo and copy the **Repository URI** (e.g. `123456789.dkr.ecr.ap-south-1.amazonaws.com/build-server`). You'll need this for the Docker push and the ECS Task Definition.

### D. Build & Push the `build-server` Docker Image

The `build-server/` directory contains:

- `Dockerfile` — Ubuntu-based image that installs Node 20, git, copies `main.sh`, `script.ts`, `tsconfig.json`, `package*.json`, runs `npm install && npm run build`.
- `main.sh` — The container entrypoint. It clones the user's GitHub repo into `/home/app/output`, then runs `node dist/script.js` which builds the project and uploads the output to S3.
- `script.ts` — The TypeScript source that runs `npm install && npm run build` inside the cloned repo, then uploads the `dist/` folder to S3.

**Option 1: Using AWS Console (No CLI Required)**

1. Build the Docker image locally:
   ```bash
   cd build-server
   docker build -t build-server .
   ```

2. Go to **ECR** > click your `build-server` repository > **View push commands**.
3. Follow the 4 commands shown (they include authentication and push steps specific to your account).

**Option 2: Using AWS CLI (Requires `aws` command)**

If you have AWS CLI installed and configured:

```bash
cd build-server

# 1. Login to ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin 123456789.dkr.ecr.ap-south-1.amazonaws.com

# 2. Build the image
docker build -t build-server .

# 3. Tag the image
docker tag build-server:latest 123456789.dkr.ecr.ap-south-1.amazonaws.com/build-server:latest

# 4. Push the image
docker push 123456789.dkr.ecr.ap-south-1.amazonaws.com/build-server:latest
```

> Replace `123456789` and `ap-south-1` with your actual AWS Account ID and region.

> **Note**: AWS CLI is NOT required for running the application. It's only needed for pushing Docker images to ECR. You can use the AWS Console method instead.

### E. Setup VPC Networking (Subnets & Security Groups)

The ECS Fargate task needs **public subnets** with internet access so the container can:

- Clone from GitHub
- Upload to S3
- Publish logs to Redis

1. Go to **VPC** > **Subnets**.
2. Filter by your default VPC. Copy the **Subnet IDs** of 2–3 public subnets (ones that have a route to an Internet Gateway). Example:
  - `subnet-0abc111111111`
  - `subnet-0abc222222222`
  - `subnet-0abc333333333`
3. Go to **Security Groups**. Copy the **Security Group ID** of your default VPC security group (or create one that allows **all outbound traffic**). Example:
  - `sg-0abc444444444`

> You'll paste these into `api-server/index.ts`.

### F. Create ECS Cluster

1. Go to **ECS** > **Clusters** > **Create cluster**.
2. Cluster name: `vercel-clone-cluster`.
3. Infrastructure: **AWS Fargate** (serverless).
4. After creation, copy the **Cluster ARN** (e.g. `arn:aws:ecs:ap-south-1:123456789:cluster/vercel-clone-cluster`).

### G. Create ECS Task Definition

1. Go to **ECS** > **Task definitions** > **Create new task definition**.
2. Task definition family: `vercel-clone-build-task`.
3. Launch type: **Fargate**.
4. Task execution role: select an existing role (e.g. `ecsTaskExecutionRole`) or create one with `AmazonECSTaskExecutionRolePolicy`.
5. **Container definition**:
  - Container name: `**builder-image`** (must match the `name` field in `api-server/index.ts` `containerOverrides`).
  - Image URI: your ECR image URI (e.g. `123456789.dkr.ecr.ap-south-1.amazonaws.com/build-server:latest`).
  - Environment variables (these will be overridden at runtime by the api-server, but set defaults):
    - `GIT_REPOSITORY__URL` = (leave blank)
    - `PROJECT_ID` = (leave blank)
    - `AWS_ACCESS_KEY_ID` = your key
    - `AWS_SECRET_ACCESS_KEY` = your secret
    - `AWS_REGION` = `ap-south-1`
    - `REDIS_URL` = your Redis connection string (see Section 2)
6. Task CPU: `1 vCPU`, Memory: `2 GB` (minimum for npm builds).
7. After creation, copy the **Task Definition ARN** (e.g. `arn:aws:ecs:ap-south-1:123456789:task-definition/vercel-clone-build-task:1`).

---

## 2. Redis Setup

The `api-server` subscribes to build logs via Redis pub/sub, and the `build-server` publishes logs to the same Redis instance.

### Option 1: Local Redis (for local-only testing)

```bash
# macOS
brew install redis
redis-server
```

Connection string: `redis://localhost:6379`

> This only works if the build-server also runs locally (not on ECS). For ECS, you need a cloud-hosted Redis.

### Option 2: Cloud Redis (required for ECS)

Use one of:

- **AWS ElastiCache** (Redis) — create a cluster, get the endpoint.
- **Redis Cloud** (free tier at [redis.io](https://redis.io)) — create an instance, get the connection string.
- **Upstash** (serverless Redis at [upstash.com](https://upstash.com)) — create a database, get the REST/Redis URL.

Your Redis URL will look like: `rediss://default:PASSWORD@HOST:PORT`

> The same Redis URL must be used by both `api-server` and the ECS `build-server` container.

---

## 3. Environment Configuration

Each service has a `.env.example` file with all required variables. Copy these to `.env` and fill in your actual values.

### Setup `.env` Files

```bash
# From project root
cp api-server/.env.example api-server/.env
cp build-server/.env.example build-server/.env
cp s3-reverse-proxy/.env.example s3-reverse-proxy/.env
cp frontend-nextjs/.env.example frontend-nextjs/.env.local
```

> **Important**: Never commit `.env` files to git. They contain sensitive credentials.

### `api-server/.env`

The following values are read from environment variables:


| Variable                | Where to Get It                   | Example                                                                      |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `AWS_REGION`            | Your chosen AWS region            | `ap-south-1`                                                                 |
| `AWS_ACCESS_KEY_ID`     | IAM user credentials (Section 1A) | `AKIA...`                                                                    |
| `AWS_SECRET_ACCESS_KEY` | IAM user credentials (Section 1A) | `wJalrX...`                                                                  |
| `ECS_CLUSTER_ARN`       | ECS Cluster (Section 1F)          | `arn:aws:ecs:ap-south-1:123456789:cluster/vercel-clone-cluster`              |
| `ECS_TASK_ARN`          | ECS Task Definition (Section 1G)  | `arn:aws:ecs:ap-south-1:123456789:task-definition/vercel-clone-build-task:1` |
| `ECS_SUBNETS`           | VPC Subnets (Section 1E)          | `subnet-0abc111,subnet-0abc222,subnet-0abc333` (comma-separated)             |
| `ECS_SECURITY_GROUPS`   | Security Groups (Section 1E)      | `sg-0abc444` (comma-separated)                                               |
| `REDIS_URL`             | Redis instance (Section 2)        | `redis://localhost:6379` or cloud URL                                        |
| `PORT`                  | Optional, defaults to `9000`      | `9000`                                                                       |


### `build-server/.env`

These are set as **ECS Task Definition environment variables** (Section 1H), injected at container runtime:


| Variable                | Where to Get It                   | Example                          |
| ----------------------- | --------------------------------- | -------------------------------- |
| `AWS_REGION`            | Your chosen AWS region            | `ap-south-1`                     |
| `AWS_ACCESS_KEY_ID`     | IAM user credentials (Section 1A) | `AKIA...`                        |
| `AWS_SECRET_ACCESS_KEY` | IAM user credentials (Section 1A) | `wJalrX...`                      |
| `S3_BUCKET_NAME`        | S3 Bucket (Section 1B)            | `vercel-clone-outputs`           |
| `REDIS_URL`             | Cloud Redis (Section 2)           | `rediss://default:xxx@host:port` |
| `GIT_REPOSITORY__URL`   | Injected by api-server at runtime | (auto)                           |
| `PROJECT_ID`            | Injected by api-server at runtime | (auto)                           |


> For local testing, you can create a `.env` file. For ECS, these are set in the Task Definition.

### `s3-reverse-proxy/.env`


| Variable            | Where to Get It                   | Example                                                              |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `OUTPUTS_BASE_PATH` | Your S3 bucket URL + `/__outputs` | `https://vercel-clone-outputs.s3.ap-south-1.amazonaws.com/__outputs` |
| `PORT`              | Optional, defaults to `8000`      | `8000`                                                               |


### `frontend-nextjs/.env.local`


| Variable                 | Where to Get It        | Example                 |
| ------------------------ | ---------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL`    | API server URL         | `http://localhost:9000` |
| `NEXT_PUBLIC_SOCKET_URL` | Socket.io server URL   | `http://localhost:9002` |


> Next.js requires the `NEXT_PUBLIC_` prefix for client-side environment variables.

---

## 4. Install Dependencies

Run `npm install` in **every** service:

```bash
cd api-server && npm install && cd ..
cd build-server && npm install && cd ..
cd s3-reverse-proxy && npm install && cd ..
cd frontend-nextjs && npm install && cd ..
```

---

## 5. Start All Services Locally

Open **4 separate terminals** from the project root:

### Terminal 1 — Redis

```bash
redis-server
```

### Terminal 2 — API Server (port 9000) + Socket.io Server (port 9002)

```bash
cd api-server
npm run build && npm start
```

You should see:

```
Socket Server 9002
Subscribed to logs....
API Server Running..9000
```

### Terminal 3 — S3 Reverse Proxy (port 8000)

```bash
cd s3-reverse-proxy
npm run build && npm start
```

You should see:

```
Reverse Proxy Running..8000
```

### Terminal 4 — Frontend (port 3000)

```bash
cd frontend-nextjs
npm run dev
```

You should see:

```
▲ Next.js 16.1.6 (Turbopack)
- Local: http://localhost:3000
```

### Running Services Summary


| S.No | Service            | PORT    | Description                          |
| ---- | ------------------ | ------- | ------------------------------------ |
| 1    | `redis-server`     | `:6379` | Pub/sub for build logs               |
| 2    | `api-server`       | `:9000` | REST API — triggers ECS builds       |
| 3    | `socket.io-server` | `:9002` | WebSocket — streams logs to frontend |
| 4    | `s3-reverse-proxy` | `:8000` | Serves deployed sites via subdomains |
| 5    | `frontend-nextjs`  | `:3000` | Web UI for deploying projects        |


---

## 6. End-to-End Test

### Step 1 — Open the Frontend

Go to `http://localhost:3000` in your browser.

### Step 2 — Enter a GitHub Repo URL

Use any **public** repository that has a `package.json` with a `build` script that produces a `dist/` folder (e.g. a Vite or CRA project):

```
https://github.com/niconiahi/astro-htmx-example
```

### Step 3 — Click "Deploy"

What happens behind the scenes:

1. Frontend sends `POST http://localhost:9000/project` with `{ gitURL, slug }`.
2. `api-server` generates a random slug (e.g. `fluffy-green-penguin`) and calls `RunTaskCommand` to spin up an ECS Fargate task.
3. ECS launches the `builder-image` container with env vars `GIT_REPOSITORY__URL` and `PROJECT_ID`.
4. Inside the container, `main.sh` runs:
  - `git clone <GIT_REPOSITORY__URL> /home/app/output`
  - `node dist/script.js`
5. `script.ts` runs `npm install && npm run build` inside the cloned repo.
6. Build logs are published to Redis channel `logs:<PROJECT_ID>`.
7. `api-server` picks up logs via `psubscribe('logs:*')` and pushes them to the frontend via Socket.io.
8. After build completes, `script.ts` uploads every file in `output/dist/` to S3 at `__outputs/<PROJECT_ID>/<file>` with the correct `Content-Type`.

### Step 4 — Watch Logs

You'll see real-time build logs streaming in the green terminal UI on the frontend:

```
> Build Started...
> npm install output...
> Build Complete
> Starting to upload
> uploading index.html
> uploaded index.html
> Done
```

### Step 5 — Visit the Deployed Site

The frontend shows a preview URL like:

```
http://fluffy-green-penguin.localhost:8000
```

Open this URL. Here's how the reverse proxy resolves it:

1. Browser requests `fluffy-green-penguin.localhost:8000`.
2. `s3-reverse-proxy` extracts subdomain `fluffy-green-penguin` from `req.hostname`.
3. It proxies to `https://vercel-clone-outputs.s3.ap-south-1.amazonaws.com/__outputs/fluffy-green-penguin/`.
4. If the path is `/`, it appends `index.html`.
5. S3 returns the static file and the proxy streams it back to the browser.

---

## 7. Verifying Each Component Individually

### Test the API Server

```bash
curl -X POST http://localhost:9000/project \
  -H "Content-Type: application/json" \
  -d '{"gitURL": "https://github.com/user/repo"}'
```

Expected response:

```json
{
  "status": "queued",
  "data": {
    "projectSlug": "random-slug-name",
    "url": "http://random-slug-name.localhost:8000"
  }
}
```

### Test Redis Pub/Sub

In one terminal:

```bash
redis-cli PSUBSCRIBE "logs:*"
```

In another:

```bash
redis-cli PUBLISH "logs:test-project" '{"log":"hello from test"}'
```

The subscriber should print the message.

### Test the Reverse Proxy

After a successful deployment, verify S3 has the files:

```bash
aws s3 ls s3://vercel-clone-outputs/__outputs/<project-slug>/
```

Then curl the proxy:

```bash
curl -H "Host: <project-slug>.localhost" http://localhost:8000/
```

You should get the `index.html` content back.

### Test the Docker Image Locally (optional)

You can test the `build-server` without ECS:

```bash
cd build-server
docker build -t build-server .

docker run \
  -e GIT_REPOSITORY__URL="https://github.com/user/repo" \
  -e PROJECT_ID="local-test" \
  -e AWS_ACCESS_KEY_ID="AKIA..." \
  -e AWS_SECRET_ACCESS_KEY="wJalrX..." \
  -e AWS_REGION="ap-south-1" \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  build-server
```

> `host.docker.internal` lets the container reach your local Redis on macOS/Windows. On Linux, use `--network=host` instead.

---

## 8. Troubleshooting


| Problem                                    | Cause                                | Fix                                                                                                                       |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Frontend can't reach API (`Network Error`) | CORS or API not running              | Ensure `api-server` is running on port 9000. Check `cors: { origin: '*' }` in socket.io config.                           |
| ECS task fails immediately                 | Bad Docker image or missing env vars | Check ECS task logs in **CloudWatch**. Ensure the ECR image URI is correct in the Task Definition.                        |
| ECS task can't clone from GitHub           | No internet in subnet                | Ensure subnets have a route to an **Internet Gateway** (public subnets).                                                  |
| ECS task can't upload to S3                | Wrong credentials or bucket name     | Verify `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the Task Definition env vars. Check the bucket name in `script.ts`. |
| No logs appearing in frontend              | Redis not connected                  | Verify `REDIS_URL` is the same in both `api-server` and the ECS Task Definition. Test with `redis-cli PING`.              |
| `localhost:8000` shows nothing             | Reverse proxy can't reach S3         | Verify `OUTPUTS_BASE_PATH` matches your bucket URL. Run `aws s3 ls` to confirm files exist.                               |
| Subdomain not resolving                    | Browser DNS issue                    | `*.localhost` resolves to `127.0.0.1` on most systems. If not, add `127.0.0.1 slug.localhost` to `/etc/hosts`.            |
| `iam:PassRole` error on RunTask            | Missing IAM permission               | Add `iam:PassRole` permission to the IAM user for the ECS task execution role ARN.                                        |
| Build fails inside container               | Project has no `dist/` output        | The script expects `npm run build` to produce a `dist/` folder. Ensure the target repo uses Vite, CRA, or similar.        |


