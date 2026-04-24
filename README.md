# VibeSpace

VibeSpace is a lightweight real-time watch-party app built with a single Node.js server and a browser-based client. It synchronizes YouTube or direct video playback, supports live chat, and adds small-room camera sharing with WebRTC signaling over Socket.IO.

## Features

- Shared room-based playback with one host controlling the timeline
- Support for YouTube links and direct MP4/WebM/Ogg video URLs
- In-memory media queue and in-memory live chat
- WebRTC camera sharing for small groups
- Reconnect-friendly room handling after refresh
- Focus view mode for large video playback with camera and chat support
- Responsive layout for desktop, tablet, and mobile devices

## Tech Stack

- Frontend: plain HTML, CSS, and JavaScript in `index.html`
- Backend: Node.js HTTP server in `server.js`
- Real-time events: `socket.io`
- Browser media: WebRTC and YouTube IFrame API

## Project Structure

- `index.html`
  Browser UI, layout, playback sync logic, chat rendering, focus mode, and WebRTC client behavior.
- `server.js`
  Static file serving, room state management, queue handling, chat events, playback sync, and WebRTC signaling.
- `package.json`
  Project dependency manifest.

## How It Works

### 1. Room Management

The server keeps room state in memory using a `Map`. Each room stores:

- room id
- host socket id
- connected users
- chat history
- media queue
- current media item
- playback state

When a user joins:

- the room is created if needed
- the socket joins the Socket.IO room
- the user is added to the room user list
- a host is assigned if one does not already exist
- the latest room state is sent to clients

### 2. Playback Synchronization

The host is authoritative for playback.

The server listens for:

- `play`
- `pause`
- `seek`
- `heartbeat`
- `ended`

Clients use the server timestamp and playback position to estimate where playback should be. Heartbeats are sent while playback is running so viewers can correct drift without visible desync.

### 3. Media Queue

Users can add supported links to the queue. The server parses:

- YouTube URLs
- `youtu.be` URLs
- `youtube-nocookie.com` URLs
- direct video file URLs such as `.mp4`, `.webm`, `.ogg`, and `.m4v`

If nothing is currently playing, the next item in the queue becomes the active media item.

### 4. Chat

Chat messages are stored in memory and broadcast to the room in real time. Because there is no database, chat resets when the server restarts.

### 5. Camera / WebRTC

The app uses peer-to-peer WebRTC for camera and microphone sharing:

- Socket.IO is used only for signaling
- browsers exchange SDP offers, answers, and ICE candidates through the server
- media flows directly between browsers

This is suitable for small rooms. For larger rooms, an SFU architecture would be a better next step.

## Current UI Modes

### Default Mode

The standard layout shows:

- room controls
- synchronized media player
- video lounge
- queue
- chat

### Focus View Mode

Focus view reorganizes the page to emphasize playback:

- large media stage
- camera panel beside the video
- chat below the camera panel
- queue hidden while focus mode is active

## Local Development

### Prerequisites

- Node.js 18+ recommended
- npm

### Install Dependencies

```bash
npm install
```

### Run the App

```bash
node server.js
```

Then open:

```text
http://localhost:3000
```

## GitHub Deployment Workflow

### 1. Create a Git Repository

If this folder is not already a Git repository:

```bash
git init
git add .
git commit -m "Initial VibeSpace app"
```

### 2. Create a GitHub Repository

Create a new repository on GitHub, for example:

```text
vibespace
```

### 3. Connect Local Project to GitHub

Replace `<your-repo-url>` with your actual GitHub repo URL:

```bash
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

### 4. Future Updates

For later changes:

```bash
git add .
git commit -m "Describe your update"
git push
```

## Render Deployment Guide

Render can deploy this project as a Node web service directly from GitHub.

### Option A: Create a Web Service in Render UI

1. Push this project to GitHub.
2. Log in to Render.
3. Click `New +`.
4. Choose `Web Service`.
5. Connect your GitHub repository.
6. Configure the service with values like these:

- Name: `vibespace`
- Environment: `Node`
- Build Command: `npm install`
- Start Command: `node server.js`

### Port Configuration

No hardcoded production port change is needed because the app already uses:

```js
const PORT = process.env.PORT || 3000;
```

Render will inject `PORT` automatically.

### Option B: Recommended Render Settings

Use these basic settings:

- Branch: `main`
- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `node server.js`
- Auto Deploy: enabled

## Deployment Notes

- Room state, queue, and chat are stored in memory only.
- If the server restarts, all rooms reset.
- WebRTC behavior depends on browser permissions and peer connectivity.
- Public deployment may need TURN infrastructure for more reliable WebRTC across restrictive networks.

## Recommended Next Improvements

- Add `start` and `dev` scripts to `package.json`
- Add persistent storage for rooms and chat
- Add TURN server configuration for stronger WebRTC connectivity
- Add authentication or private room controls
- Add tests for room state and playback sync logic
- Add deployment config such as `render.yaml`

## Quick Start Summary

### Run Locally

```bash
npm install
node server.js
```

### Deploy to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

### Deploy to Render

- Create a new Web Service from the GitHub repo
- Build Command: `npm install`
- Start Command: `node server.js`

## Limitations

- No database
- No authentication
- No SFU for large rooms
- In-memory room state only
- WebRTC quality depends on browser and network conditions

## License

Add your preferred license before publishing publicly.
