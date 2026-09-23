# FREE  Revised VNC Implementation Plan

## 1. Overview

Add VNC as a **standalone connection type** in FREE, alongside SSH and other supported connection types.

VNC connections should have their own configuration, credentials, lifecycle, and connection tabs. They must not be implemented as an additional feature or panel belonging to an SSH host.

Users should be able to create a VNC connection, connect to an existing remote desktop, or optionally have FREE initialize a remote VNC server when one is not running.

**Core design principle:** FREE should handle as much setup as possible, detect missing requirements automatically, and present actionable instructions only when user intervention is necessary.

---

# 2. Connection Architecture

## 2.1 VNC as an independent connection type

Update FREE's connection model to support multiple connection types.

```typescript
type ConnectionType =
  | "ssh"
  | "vnc";
```

Each connection type should have its own configuration and functionality.

```text
FREE
¦
+-- Connections
¦   ¦
¦   +-- Production Server          [SSH]
¦   ¦
¦   +-- Development Machine        [SSH]
¦   ¦
¦   +-- Ubuntu Desktop             [VNC]
¦   ¦
¦   +-- Remote Workstation         [VNC]
¦   ¦
¦   +-- Raspberry Pi Desktop       [VNC]
¦
+-- Tabs
    ¦
    +-- SSH Terminal
    +-- SFTP
    +-- VNC Desktop
```

The connection list should distinguish connection types using icons and labels.

For example:

- SSH: Terminal icon
- VNC: Monitor icon

Opening a VNC connection should directly open the remote desktop, rather than opening an SSH tab and then requiring the user to select a VNC panel.

## 2.2 VNC transport

Support two connection methods.

| Transport | Description |
|---|---|
| SSH Tunnel | Connect to a VNC server through an encrypted SSH tunnel. |
| Direct | Connect to an existing VNC server directly through the FREE backend. |

**SSH Tunnel should be the recommended default.**

For an SSH-tunneled connection:

```text
Browser
   ¦
   ¦ WebSocket
   ?
FREE Backend
   ¦
   ¦ SSH Tunnel
   ?
Remote Machine
   ¦
   ¦ localhost:5901
   ?
VNC Server
   ¦
   ?
Remote Desktop
```

The VNC connection may reference an existing saved SSH connection for transport, but it remains an independent connection.

For example:

```text
Connection: Ubuntu Desktop

Type: VNC
Transport: SSH Tunnel
SSH Connection: Production Server
VNC Port: 5901
```

Users should also be able to configure SSH transport credentials directly in the VNC connection if they do not want to create a separate SSH connection.

For direct connections:

```text
Browser
   ¦
   ¦ WebSocket
   ?
FREE Backend
   ¦
   ¦ TCP / TLS
   ?
VNC Server
```

Direct connections require an already-running VNC server. FREE cannot automatically install or start remote services through direct VNC access alone.

Direct VNC should be presented as suitable for trusted networks or properly secured VNC endpoints, rather than as a replacement for SSH transport over the public internet.

---

# 3. VNC Connection Configuration

Create a dedicated VNC connection form.

### Basic Configuration

| Field | Description | Default |
|---|---|---|
| Name | Display name | Required |
| Type | Connection type | VNC |
| Transport | SSH Tunnel / Direct | SSH Tunnel |
| Address | Remote address | Required |
| Port | Remote VNC port | Auto / 5900 |
| Password | VNC authentication password | Optional |

### SSH Tunnel Configuration

Only display these fields when SSH Tunnel is selected.

| Field | Description |
|---|---|
| SSH Connection | Optional existing saved SSH connection |
| SSH Host | Remote SSH address |
| SSH Port | Default 22 |
| SSH Username | Authentication username |
| SSH Authentication | Password or SSH key |

The user should either select an existing SSH connection or enter SSH credentials directly.

### Advanced Configuration

| Field | Description | Default |
|---|---|---|
| Desktop Mode | Automatic / Existing / Virtual | Automatic |
| Auto-start VNC | Start the VNC server if required | Enabled for configured virtual sessions |
| Auto-stop VNC | Stop FREE-managed VNC servers on disconnect | Disabled |
| VNC Implementation | Auto / TigerVNC / x11vnc | Auto |
| Display Number | Remote display | Auto |
| View Only | Disable keyboard and mouse input | Disabled |
| Desktop Scaling | Fit desktop to available space | Enabled |

VNC credentials must be stored using FREE's existing secret-encryption system rather than plaintext database fields.

---

# 4. VNC Connection Workflow

This is the most important part of the revised implementation.

When a user opens a VNC connection, FREE should first determine whether it can establish the desktop connection immediately.

Only initiate additional setup when necessary.

## 4.1 Primary connection flow

```text
User Opens VNC Connection
          ¦
          ?
Establish Transport
          ¦
          +-- Failed
          ¦     ¦
          ¦     ?
          ¦   Show Transport Error
          ¦
          ?
Probe VNC Port
          ¦
          +-- VNC Server Running
          ¦       ¦
          ¦       ?
          ¦   Connect to Desktop
          ¦
          +-- VNC Server Not Running
                  ¦
                  ?
           Check Transport Type
                  ¦
                  +-- Direct
                  ¦      ¦
                  ¦      ?
                  ¦   Show Setup Instructions
                  ¦
                  +-- SSH
                         ¦
                         ?
                 Diagnose Remote System
                         ¦
                         ?
                 Check VNC Dependencies
                         ¦
                  +-------------+
                  ¦             ¦
               Available      Missing
                  ¦             ¦
                  ?             ?
              Start VNC     Show Setup
                  ¦         Disclaimer
                  ?
             Verify Desktop
                  ¦
                  ?
             Open VNC Tab
```

**A missing or closed VNC port should not immediately be treated as an error.**

FREE should first determine whether the necessary server can be started.

---

# 5. Remote Environment Detection

Introduce a dedicated diagnostic mechanism.

```typescript
diagnoseVncEnvironment(connection)
```

This function should connect to the remote machine through SSH and inspect its environment without modifying anything.

## 5.1 Required checks

| Check | Purpose |
|---|---|
| Operating system | Determine supported installation methods |
| Architecture | Identify system architecture when relevant |
| VNC port | Check whether a VNC service is running |
| VNC implementation | Detect installed VNC server software |
| Desktop environment | Identify available graphical sessions |
| Display server | Determine X11 / Wayland availability |
| Display number | Discover existing or available displays |
| Permissions | Verify the SSH user can start or access the server |

Suggested return type:

```typescript
interface VncDiagnostics {
  os: string;
  distribution?: string;

  architecture?: string;

  vnc: {
    installed: boolean;
    running: boolean;

    implementation?:
      | "tigervnc"
      | "x11vnc"
      | "unknown";

    port?: number;
    display?: number;
  };

  desktop: {
    installed: boolean;

    environment?:
      | "xfce"
      | "gnome"
      | "kde"
      | "mate"
      | "other";

    displayServer?:
      | "x11"
      | "wayland"
      | "unknown";
  };

  permissions: {
    canStartVnc: boolean;
    canAccessDisplay: boolean;
  };

  requirements: VncRequirement[];
}
```

Do not assume that `command -v vncserver` identifies a specific implementation. Several VNC packages provide similarly named executables. Detect the implementation through version output, supported options, or package metadata where possible.

Likewise, check whether a suitable desktop session can actually be launched rather than relying only on installed package names.

---

# 6. Conditional Setup Disclaimers

The application should **never show generic VNC setup warnings before checking the remote environment**, provided SSH diagnostics are available.

This would create unnecessary friction for users whose machines are already correctly configured.

Instead, implement a reusable setup disclaimer component that appears only when diagnostics identify a missing requirement or unresolved problem.

## 6.1 Scenario A: Everything is ready

Remote machine:

```text
TigerVNC: Installed
Desktop Environment: XFCE
VNC Server: Running
```

Behavior:

Connect immediately.

No disclaimer.

## 6.2 Scenario B: VNC installed but not running

Remote machine:

```text
TigerVNC: Installed
Desktop Environment: XFCE
VNC Server: Not Running
```

Behavior:

If automatic startup is enabled, start the VNC server.

Show a normal connection status:

> Starting remote desktop...

If startup succeeds, open the desktop.

If startup fails, show a diagnostic error with the relevant details.

## 6.3 Scenario C: VNC server not installed

Remote machine:

```text
TigerVNC: Missing
x11vnc: Missing
Desktop Environment: XFCE
```

Show a setup disclaimer:

**Remote desktop setup required**

FREE couldn't find a compatible VNC server on this machine.

To use remote desktop, install a VNC server on the remote machine. Your existing SSH and SFTP connections will continue to work normally.

For an Ubuntu/Debian system, for example:

```bash
sudo apt update
sudo apt install tigervnc-standalone-server
```

Buttons:

```text
[Copy Commands]    [Check Again]
```

Include a link to installation instructions for the detected operating system when available.

Don't show Ubuntu commands on Fedora, Arch, or other distributions.

Don't silently run package installation commands.

## 6.4 Scenario D: Desktop environment missing

Remote machine:

```text
TigerVNC: Installed
Desktop Environment: Missing
```

Show:

**A desktop environment is required**

FREE found a VNC server, but couldn't detect a graphical desktop session suitable for starting a virtual desktop.

Install a desktop environment such as XFCE to enable remote desktop access.

For supported Ubuntu/Debian distributions, an example is:

```bash
sudo apt install xfce4 xfce4-goodies
```

Buttons:

```text
[Copy Commands]    [Check Again]
```

A detected installation is not a guarantee that its session configuration is valid; the subsequent startup verification should catch incomplete configurations.

## 6.5 Scenario E: Existing desktop unavailable

If the user selects Existing Desktop but the machine does not have an accessible X11 session, show:

**No accessible desktop session found**

FREE could not detect an X11 desktop session that the current SSH user can access.

You can either:

- Log into an X11 desktop session on the remote machine.
- Create a separate virtual desktop instead.

Buttons:

```text
[Use Virtual Desktop]    [Check Again]
```

Do not silently replace the existing-desktop mode with virtual-desktop mode.

`x11vnc` attaches to X11 displays and requires appropriate display access and authorization; it is not a general-purpose Wayland screen-sharing solution. :chatgpt-content-reference{index="0"}

---

# 7. Setup Disclaimer Component

Create:

```text
src/components/vnc/VncSetupDisclaimer.tsx
```

The component should accept structured diagnostics instead of hardcoded messages.

```typescript
type VncRequirement =
  | {
      type: "vnc_server_missing";
      severity: "blocking";
      message: string;
      installCommands?: string[];
    }
  | {
      type: "desktop_missing";
      severity: "blocking";
      message: string;
      installCommands?: string[];
    }
  | {
      type: "display_unavailable";
      severity: "blocking";
      message: string;
    }
  | {
      type: "permission_denied";
      severity: "blocking";
      message: string;
    }
  | {
      type: "unsupported_environment";
      severity: "blocking";
      message: string;
    };
```

A corresponding backend utility should convert diagnostic results into actionable requirements.

```typescript
getVncRequirements(
  diagnostics: VncDiagnostics
): VncRequirement[]
```

This keeps system detection separate from the frontend presentation.

If SSH access fails, or the user is using direct transport, report that the environment could not be inspected instead of claiming that a particular dependency is missing.

---

# 8. VNC Server Management

Implement two server modes.

## 8.1 Existing desktop

Use `x11vnc` for accessible X11 desktop sessions.

```text
Existing X11 Desktop
        ¦
        ?
      x11vnc
        ¦
        ?
      FREE
```

FREE should check:

- Whether an existing VNC server is already serving the desktop.
- Whether `x11vnc` is installed.
- Whether the target display exists.
- Whether the SSH user has access to the display.
- Whether starting the service is permitted by the user's configuration.

Do not assume that `:0` is always the correct display.

## 8.2 Virtual desktop

Use TigerVNC.

```text
Virtual Desktop
       ¦
       ?
     Xvnc
       ¦
       ?
     FREE
```

FREE should:

1. Check whether a suitable virtual desktop already exists.
2. Determine an available display and port.
3. Verify that the desktop environment is configured.
4. Start TigerVNC if automatic startup is enabled.
5. Wait until the server becomes accessible.
6. Connect noVNC to the resulting session.

TigerVNC supports separate virtual desktops and configurable RFB ports; the conventional default port is 5900 plus the display number. Its documentation also recommends using the appropriate session startup mechanism rather than treating a bare `Xvnc` process as a fully initialized desktop. :chatgpt-content-reference{index="1"}

### Managed server ownership

FREE must distinguish between services it starts and existing VNC servers.

```typescript
interface ManagedVncSession {
  connectionId: number;

  implementation: "tigervnc" | "x11vnc";

  port: number;
  display?: number;

  managed: boolean;

  pid?: number;

  startedAt?: string;
}
```

Only automatically stop servers that FREE owns.

Do not use unrestricted `pkill` commands.

Use a per-connection startup lock to prevent concurrent requests from creating duplicate VNC servers.

---

# 9. Backend Implementation

Organize VNC as an independent backend feature.

```text
server/
¦
+-- vnc/
¦   ¦
¦   +-- index.ts
¦   ¦
¦   +-- types.ts
¦   ¦
¦   +-- transport.ts
¦   ¦
¦   +-- probe.ts
¦   ¦
¦   +-- diagnostics.ts
¦   ¦
¦   +-- requirements.ts
¦   ¦
¦   +-- server-detection.ts
¦   ¦
¦   +-- lifecycle.ts
¦   ¦
¦   +-- sessions.ts
¦   ¦
¦   +-- websocket.ts
¦
+-- routes/
    ¦
    +-- vnc.ts
```

### Module responsibilities

| Module | Responsibility |
|---|---|
| `transport.ts` | Establish direct or SSH-tunneled connections |
| `probe.ts` | Detect an RFB server on the configured port |
| `diagnostics.ts` | Inspect remote operating system and graphical environment |
| `requirements.ts` | Determine whether user intervention is required |
| `server-detection.ts` | Identify installed VNC implementations |
| `lifecycle.ts` | Start and stop managed VNC services |
| `sessions.ts` | Track ownership and active desktop sessions |
| `websocket.ts` | Bridge the browser's WebSocket to the RFB stream |

### REST API

```text
GET    /api/vnc/:connectionId/status

POST   /api/vnc/:connectionId/diagnose

POST   /api/vnc/:connectionId/ensure

POST   /api/vnc/:connectionId/stop
```

The diagnostics endpoint returns the structured result and any setup requirements.

The ensure endpoint performs the connection preparation flow and starts a VNC server only when permitted.

### WebSocket

```text
/ws/vnc?connection_id=N
```

The WebSocket should connect directly to the configured VNC connection, not resolve VNC settings through an SSH host.

Before opening the remote desktop stream, enforce authentication, per-connection authorization, and WebSocket origin validation.

The binary WebSocket bridge must preserve the RFB byte stream and handle backpressure, disconnects, and SSH tunnel cleanup.

---

# 10. Database Changes

Do not add VNC-specific fields to the existing SSH host model.

Instead, extend FREE's connection system.

A suggested relational design:

```text
connections
¦
+-- id
+-- name
+-- type
+-- created_at
+-- updated_at
```

SSH-specific settings:

```text
ssh_connections
¦
+-- connection_id
+-- hostname
+-- port
+-- username
+-- authentication
```

VNC-specific settings:

```text
vnc_connections
¦
+-- connection_id
+-- hostname
+-- port
+-- transport
+-- ssh_connection_id
+-- ssh_config
+-- vnc_password
+-- desktop_mode
+-- implementation
+-- auto_start
+-- auto_stop
+-- display
```

The `ssh_connection_id` field is optional.

It simply allows a VNC connection to reuse saved SSH transport settings.

It should not make VNC a child record of an SSH host.

If the existing database uses a single hosts table and separate feature configuration is more consistent with FREE's current design, implement an equivalent migration while retaining backward compatibility with existing SSH connections.

Existing users must not lose their saved connections.

---

# 11. Frontend Implementation

## Components

```text
src/
¦
+-- components/
¦   ¦
¦   +-- connections/
¦   ¦   +-- ConnectionList.tsx
¦   ¦   +-- ConnectionForm.tsx
¦   ¦
¦   +-- vnc/
¦       ¦
¦       +-- VncConnectionForm.tsx
¦       +-- VncView.tsx
¦       +-- VncToolbar.tsx
¦       +-- VncStatus.tsx
¦       +-- VncSetupDisclaimer.tsx
```

### Connection list

The main connection list should display SSH and VNC connections together.

```text
Connections

+ New Connection

Production                 [SSH]
Development                [SSH]
Ubuntu Desktop             [VNC]
Remote Workstation         [VNC]
```

The New Connection action should present a connection type selector.

```text
Choose Connection Type

[ Terminal Icon ]
SSH
Connect to remote shells and servers.

[ Monitor Icon ]
VNC
Access and control remote desktops.
```

### VNC view

Install:

```bash
npm install @novnc/novnc
```

Use noVNC's `RFB` client to render the remote desktop. Its API accepts a WebSocket URL or channel carrying the RFB protocol stream. :chatgpt-content-reference{index="2"}

The component should manage these states:

```typescript
type VncConnectionState =
  | "disconnected"
  | "connecting"
  | "diagnosing"
  | "setup_required"
  | "starting"
  | "connected"
  | "error";
```

Suggested layout:

```text
+-------------------------------------------------------------+
¦ FREE                                                        ¦
+-------------------------------------------------------------¦
¦ [SSH: Production] [VNC: Ubuntu Desktop] [SSH: Development]   ¦
+-------------------------------------------------------------¦
¦ Ubuntu Desktop                                  ? Connected ¦
¦                                                             ¦
¦ [Reconnect] [Fullscreen] [View Only] [Disconnect]            ¦
+-------------------------------------------------------------¦
¦                                                             ¦
¦                                                             ¦
¦                    Remote Desktop                           ¦
¦                                                             ¦
¦                                                             ¦
¦                                                             ¦
+-------------------------------------------------------------+
```

When setup is required, show the disclaimer inside the VNC tab instead of the remote desktop.

---

# 12. Testing Plan

Create:

```text
tests/vnc/
¦
+-- connections.test.ts
+-- transport.test.ts
+-- probe.test.ts
+-- diagnostics.test.ts
+-- requirements.test.ts
+-- lifecycle.test.ts
+-- websocket.test.ts
```

### Essential test cases

| Test | Expected behavior |
|---|---|
| Create VNC connection | Saved independently from SSH connections |
| Open existing VNC server | Connect immediately |
| SSH tunnel unavailable | Show transport error |
| VNC installed but stopped | Auto-start if enabled |
| VNC server missing | Return installation requirement |
| Desktop environment missing | Return desktop installation requirement |
| Existing display unavailable | Suggest virtual desktop |
| Direct VNC server unavailable | Explain that remote diagnostics cannot run |
| Two simultaneous startup requests | Only one server initialization |
| Existing externally managed VNC server | Never stop it automatically |
| Disconnect browser | Clean up the WebSocket and tunnel |
| Reconnect | Reuse an existing session when appropriate |
| Unauthorized WebSocket request | Reject connection |
| Invalid VNC credentials | Show authentication error |

Also test the setup disclaimer with multiple operating systems to ensure the correct instructions appear.

---

# 13. Implementation Order

I would implement this in five phases.

| Phase | Work | Deliverable |
|---|---|---|
| 1 | Connection model, database migration, connection list, VNC form | Users can create independent VNC connections |
| 2 | Direct and SSH-tunneled transport, WebSocket bridge, noVNC renderer | Users can connect to existing VNC servers |
| 3 | Remote diagnostics, dependency detection, setup disclaimers | Users receive actionable setup instructions when needed |
| 4 | Virtual desktop initialization, process ownership, startup locking | FREE can automatically start supported VNC servers |
| 5 | Existing-desktop initialization, toolbar enhancements, comprehensive tests | Complete remote desktop experience |

**The most important milestone is Phase 3.** At that point, FREE can already provide a useful VNC experience without needing to support every possible remote environment automatically.

---

## Final Expected User Experience

A user clicks **New Connection ? VNC**.

They configure their remote address, select direct or SSH-tunneled transport, and save the connection.

When they click Connect:

**Case 1  VNC is running:** FREE opens the remote desktop immediately.

**Case 2  VNC is installed but stopped:** FREE starts the configured virtual desktop, if permitted, and connects automatically.

**Case 3  VNC is missing:** FREE detects the operating system and displays the relevant installation instructions.

**Case 4  A desktop environment is missing:** FREE explains what is missing and provides appropriate setup instructions.

**Case 5  The user completes the setup:** They click Check Again, FREE verifies the environment, and the remote desktop opens.

This provides the experience you're aiming for: **VNC feels like a first-class FREE connection type, and users are only asked to configure their remote machines when FREE has established that additional setup is necessary.**