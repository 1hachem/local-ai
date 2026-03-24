
Example when running the server in tcp mode

```bash
echo "hello hi" | nc localhost 3005
```

Example when running in socket mode

```bash
echo "hello hi" | nc -U /tmp/local-ai.socket
```

- define agents in different frameworks:
    - ai sdk from vercel
    - volt agent
    - hyko
    - workflows with trigger.dev
    - opencode?

- lego modules for:
    - context compression
    - k8s mcp deployment

- give agents different tools, mcps, reference to other agents
- local agent discovry and handshakes
- persistant inter-agent sessions (in-memory, json file, postgres)
- expose these agents for IPC either via UNIX sockets or tcp loop back
- pick up chat from previous sessions
- create cli pipes with agents in the middle (to cat files in the middle, use variables ...)

nixos integration: (useful for cloud deployment of workspaces)
- nix derivation to declare these agents as systemd services
- wake agents via socket based activations
- jailed systemd service with minimal access to commands and file-system
- use systemd crednetials and gnu pass to manage passwords and envs
- journalctl logs on whole workspace for visibility and event driven actions


TODO:
- [ ] use cmd-ts for client cli
- [ ] add option to continue from sessionId
