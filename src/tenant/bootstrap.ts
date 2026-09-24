import { readFile, writeFile, mkdir, chmod, chown } from "node:fs/promises";
import { stringify } from "yaml";
import { isIP } from "node:net";
const b = JSON.parse(await readFile(process.argv[2], "utf8"));
if (
  !/^[a-z0-9.-]+$/.test(b.hostname) ||
  !/^\S+\/\d+$/.test(b.adminCidr) ||
  !isIP(b.adminCidr.split("/")[0])
)
  throw Error("INVALID_NETWORK_CONFIG");
const root = "/host";
for (const p of [
  "/opt/sac",
  "/var/lib/sac",
  "/var/lib/sac/state",
  "/var/lib/sac/auth",
  "/var/lib/sac/exports",
  "/var/lib/sac/locks",
])
  await mkdir(root + p, { recursive: true, mode: 0o700 });
for (const p of ["/var/lib/sac/state", "/var/lib/sac/auth"])
  await chown(root + p, 1000, 1000);
const write = async (p: string, data: string, mode = 0o600) => {
  await writeFile(root + p, data, { mode });
  await chmod(root + p, mode);
};
await write("/opt/sac/tenant.json", JSON.stringify(b));
await write(
  "/opt/sac/openclaw.env",
  `OPENCLAW_GATEWAY_TOKEN=${b.gatewayToken}\n${b.inferenceKey ? `SAC_INFERENCE_KEY=${b.inferenceKey}\n` : ""}`,
);
await write(
  "/var/lib/sac/state/openclaw.json",
  JSON.stringify({
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token", token: b.gatewayToken },
      controlUi: { allowedOrigins: [`https://${b.hostname}`] },
      trustedProxies: ["172.30.0.1"],
    },
    browser: { headless: true },
    agents: { defaults: { workspace: "/home/node/.openclaw/workspace" } },
    session: { dmScope: "per-channel-peer" },
  }),
);
await chown(root + "/var/lib/sac/state/openclaw.json", 1000, 1000);
const shared = {
  image: b.openclawImage,
  init: true,
  user: "1000:1000",
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  env_file: ["/opt/sac/openclaw.env"],
  environment: {
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: "/home/node/.openclaw",
    OPENCLAW_AUTH_PROFILE_SECRET_DIR: "/home/node/.config/openclaw",
    OPENCLAW_DISABLE_BONJOUR: "1",
  },
  volumes: [
    "/var/lib/sac/state:/home/node/.openclaw",
    "/var/lib/sac/auth:/home/node/.config/openclaw",
  ],
};
await write(
  "/opt/sac/compose.yml",
  stringify({
    services: {
      openclaw: {
        ...shared,
        container_name: "openclaw",
        restart: "unless-stopped",
        ports: ["127.0.0.1:18789:18789"],
        networks: ["agent"],
        command: [
          "node",
          "dist/index.js",
          "gateway",
          "--bind",
          "lan",
          "--port",
          "18789",
          "--allow-unconfigured",
        ],
        logging: {
          driver: "local",
          options: { "max-size": "10m", "max-file": "2" },
        },
      },
      access: {
        image: b.tenantImage,
        container_name: "sac-access",
        restart: "unless-stopped",
        network_mode: "host",
        cap_add: ["NET_ADMIN"],
        environment: { TENANT_CONFIG: "/opt/sac/tenant.json" },
        volumes: [
          "/var/run/docker.sock:/var/run/docker.sock",
          "/opt/sac:/opt/sac:ro",
          "/var/lib/sac:/var/lib/sac",
          "/root/.ssh:/host-ssh",
          "/run:/host-run",
        ],
        command: ["node", "dist/tenant/main.js"],
        logging: {
          driver: "local",
          options: { "max-size": "10m", "max-file": "2" },
        },
      },
    },
    networks: { agent: { ipam: { config: [{ subnet: "172.30.0.0/24" }] } } },
  }),
);
await write(
  "/usr/local/bin/sac-onboard",
  `#!/bin/bash\nset -euo pipefail\nexec 9>/var/lib/sac/locks/operation\nflock 9\ndocker exec -it openclaw node dist/index.js onboard --classic --no-install-daemon\ndocker exec openclaw node dist/index.js config set gateway.auth.mode token >/dev/null\ndocker exec openclaw node dist/index.js config set gateway.auth.token ${b.gatewayToken} >/dev/null\ndocker exec openclaw node dist/index.js config set gateway.controlUi.allowedOrigins '["https://${b.hostname}"]' --strict-json >/dev/null\ndocker restart openclaw >/dev/null\n`,
  0o700,
);
await write(
  "/etc/systemd/system/sac-terminal.service",
  `[Unit]\nDescription=Owner-authenticated OpenClaw onboarding terminal\nAfter=docker.service\n[Service]\nExecStart=/usr/bin/ttyd -W -O -i 127.0.0.1 -p 7681 -b /terminal /usr/local/bin/sac-onboard\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n`,
  0o644,
);
await write(
  "/etc/caddy/Caddyfile",
  `${b.hostname} {\n  header {\n    Referrer-Policy no-referrer\n    X-Content-Type-Options nosniff\n    Strict-Transport-Security "max-age=31536000"\n    X-Frame-Options DENY\n  }\n  @access path /handoff* /sac-assets/* /internal/* /authorize /setup* /api/local/* /export*\n  handle @access {\n    reverse_proxy 127.0.0.1:3080\n  }\n  handle {\n    forward_auth 127.0.0.1:3080 {\n      uri /authorize\n    }\n    handle /terminal* {\n      reverse_proxy 127.0.0.1:7681\n    }\n    @gatewaySocket header Upgrade websocket\n    handle @gatewaySocket {\n      reverse_proxy 127.0.0.1:3080\n    }\n    handle {\n      reverse_proxy 127.0.0.1:18789\n    }\n  }\n}\n`,
  0o644,
);
// Public-only networking plus host firewall: container egress cannot reach private peers/metadata.
await write(
  "/opt/sac/firewall.sh",
  `#!/bin/bash\nset -euo pipefail\niptables -N SAC-INPUT 2>/dev/null || true\niptables -F SAC-INPUT\niptables -A SAC-INPUT -i lo -j ACCEPT\niptables -A SAC-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\niptables -A SAC-INPUT -p tcp --dport 22 -s ${b.adminCidr} -j ACCEPT\nif [ -f /var/lib/sac/ssh-cidrs ]; then\n while read -r cidr; do\n  [[ \"$cidr\" =~ ^[0-9.]+/32$ ]] || continue\n  iptables -A SAC-INPUT -p tcp --dport 22 -s \"$cidr\" -j ACCEPT\n done </var/lib/sac/ssh-cidrs\nfi\niptables -A SAC-INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT\niptables -A SAC-INPUT -p icmp -j ACCEPT\niptables -A SAC-INPUT -j DROP\niptables -C INPUT -j SAC-INPUT 2>/dev/null || iptables -I INPUT 1 -j SAC-INPUT\niptables -N DOCKER-USER 2>/dev/null || true\niptables -N SAC-EGRESS 2>/dev/null || true\niptables -F SAC-EGRESS\niptables -A SAC-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\nfor cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do\n iptables -A SAC-EGRESS -d "$cidr" -j DROP\ndone\niptables -A SAC-EGRESS -j RETURN\niptables -C DOCKER-USER -j SAC-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -j SAC-EGRESS\n`,
  0o700,
);
await write(
  "/etc/systemd/system/sac-firewall.service",
  "[Unit]\nDescription=SAC firewall\nAfter=docker.service\nRequires=docker.service\nPartOf=docker.service\n[Service]\nType=oneshot\nExecStart=/opt/sac/firewall.sh\nRemainAfterExit=yes\n[Install]\nWantedBy=multi-user.target\n",
  0o644,
);
await write(
  "/etc/sysctl.d/90-sac.conf",
  "net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\n",
  0o644,
);
await write(
  "/etc/ssh/sshd_config.d/90-sac.conf",
  "PasswordAuthentication no\nPermitRootLogin prohibit-password\n",
  0o600,
);
