# Restore your agent on another Linux computer

The encrypted archive is independent of UpCloud. It includes the complete quiesced OpenClaw state and workspace, auth encryption material, environment secrets, checksums, original image digest, and these instructions. It does not contain cloud-account, DNS, billing, or shared upstream inference-provider credentials.

1. Install Docker Engine, Compose, and age on the destination. Keep the old agent stopped during cutover to avoid duplicate message processing.
2. Decrypt with your private age identity: `age -d -i identity.txt -o agent.tar agent.tar.age`. Extract into a new private directory: `mkdir -m 700 restored && tar -xf agent.tar -C restored`.
3. In that directory run `sha256sum -c SHA256SUMS`. Stop if any check fails. Read `manifest.json`; use exactly its OpenClaw image and digest for the first restore.
4. Create the following `compose.yml`, replacing `IMAGE_FROM_MANIFEST` with that image. The environment file contains secrets; keep it mode 600. Make state and auth directories owned by UID/GID 1000.

```yaml
services:
  openclaw:
    image: IMAGE_FROM_MANIFEST
    init: true
    restart: unless-stopped
    user: '1000:1000'
    env_file: openclaw.env
    environment:
      HOME: /home/node
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_AUTH_PROFILE_SECRET_DIR: /home/node/.config/openclaw
    ports: ['127.0.0.1:18789:18789']
    volumes:
      - ./state:/home/node/.openclaw
      - ./auth:/home/node/.config/openclaw
    command: [node, dist/index.js, gateway, --bind, lan, --port, '18789']
```

5. Review absolute paths and symlinks in the configuration. Custom skills, external files outside the state directory, system packages installed separately, and local browser/Mac integrations may need reinstalling. The service's standard state and workspace are included.
6. Run `docker compose up -d`, then `docker compose exec openclaw node dist/index.js doctor`. Access the dashboard with an SSH tunnel to `127.0.0.1:18789`, or configure your own authenticated HTTPS proxy and exact allowed origin. Do not expose the Gateway publicly without authentication.
7. Rotate the Gateway token and approve only your own browser. Set trusted proxy addresses for the new host; the old hostname and proxy address are not portable settings.
8. For complete independence, replace the service credit-gateway connection with a provider key you control. Other BYOK credentials and context are included. A service-issued prepaid key still depends on that service and subscription.
9. Verify memory, workspace files, sessions, tool execution, and a real reply. Check messaging connections. WhatsApp may require pairing again after old-state restoration; iMessage still needs the connected Mac. Never promise seamless credential migration for every provider.
10. Delete the decrypted tar when finished. Secure the private identity and encrypted archive. Cancel the old subscription after verifying the cutover.

Exports pause the Gateway briefly to capture consistent SQLite files. The operator's backup recovery follows the same procedure using the operator's separately stored private age identity. An export recipient public key alone cannot decrypt the archive.
