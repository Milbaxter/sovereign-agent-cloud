export type Article = {
  section: "blog" | "compare";
  slug: string;
  title: string;
  description: string;
  answer: string;
  body: string;
  related: string[];
};

// Editorial review date, not a dynamically refreshed freshness signal.
export const reviewedAt = "2026-09-24";
export const articles: Article[] = [
  {
    section: "blog",
    slug: "why-personally-owned-ai-agents",
    title: "Why your personal AI agent should belong to you",
    description:
      "What personal AI ownership means: control over memory, software, models and hosting, plus a practical way to take your context with you.",
    answer:
      "A personally owned AI agent gives you meaningful control over its software, memory, model and place of operation. The strongest test of ownership is whether you can keep using your accumulated context after changing providers.",
    body: `<h2>The value grows in the context</h2>
<p>A useful personal agent gradually learns the details that make help personal: how you plan a week, what a project is trying to achieve, and which suggestions you have already rejected. Repeating those details every time you change tools is work. Keeping them in a form you can read and reuse makes that investment more durable.</p>
<p>Imagine an agent helping with a house renovation. The valuable material includes room measurements, a budget, supplier notes and decisions made over several months. A newer model might reason better, but it should not require you to reconstruct the project from scratch.</p>
<h2>Four controls that make ownership practical</h2>
<ul><li><strong>Readable memory.</strong> You can inspect, correct, export and delete the information used to personalize responses.</li><li><strong>Software freedom.</strong> A usable source release and its license let you understand what runs, modify it, and operate your own version.</li><li><strong>Model choice.</strong> You can choose a supported model according to quality, price and processing terms.</li><li><strong>A working exit.</strong> You can recover your files and configuration, restore them elsewhere, and continue a real task.</li></ul>
<p>These are separate capabilities. A download button proves that a file can leave a service; it does not prove that another system can use it. A local application can still send prompts to an external model. Ownership needs a clear explanation of both.</p>
<h2>Why pay for an agent you can run yourself?</h2>
<p>Maintenance takes time. Updates, backups, monitoring and an always-on computer can be worth paying for. A healthy managed service earns that payment through convenience. The ability to leave gives the customer a reason to trust the arrangement.</p>
<p>Local operation is another legitimate choice. Someone who wants direct control and can maintain the system should be able to choose that path. Someone who wants help with upkeep should be able to pay for it without treating their personal context as disposable.</p>
<h2>What we are building</h2>
<p>Your Agent is a managed personal-agent project with planned Finnish hosting and supported model choice. Our <a href="https://github.com/Milbaxter/sovereign-agent-cloud">backend source is public under Apache-2.0</a>. Complete local operation and a verified migration of a working agent remain goals. Our <a href="/welcome/#ownership">ownership commitments</a> and <a href="/welcome/#faq">current boundaries</a> explain the difference.</p>
<p>The more of your life an agent helps organize, the more useful it becomes to keep the underlying context independent of a single subscription.</p>`,
    related: ["portable-ai-memory", "local-vs-hosted-ai-agents"],
  },
  {
    section: "blog",
    slug: "free-open-source-personal-ai-agent",
    title: "Free, open-source personal AI agents: what is actually free?",
    description:
      "Separate free agent software from hardware, model inference and managed hosting costs before choosing a personal AI assistant.",
    answer:
      "Free agent software can remove the software license fee. It does not remove the cost of running models, keeping a computer available, or maintaining the system. Open-source licensing and a free hosted plan also describe different things.",
    body: `<h2>Start with the four-part bill</h2>
<p>A personal AI agent combines an application, a model, a computer and ongoing maintenance. Looking at each part makes a free offer easier to understand.</p>
<div class="table-scroll"><table><caption>Where personal-agent costs come from</caption><thead><tr><th scope="col">Part</th><th scope="col">What to check</th></tr></thead><tbody><tr><th scope="row">Agent software</th><td>License terms, access to source, and permission to run and modify it.</td></tr><tr><th scope="row">Model inference</th><td>API usage charges, or the hardware and electricity needed to run a model locally.</td></tr><tr><th scope="row">Hosting</th><td>Your own computer or a server subscription, plus storage and backups.</td></tr><tr><th scope="row">Maintenance</th><td>Your time, or a fee for updates, recovery and service support.</td></tr></tbody></table></div>
<h2>Free to use and free to change</h2>
<p>A hosted free tier can be convenient, but its usage allowance does not tell you whether its software can be modified or self-hosted. Conversely, open-source software can be used as the basis of a paid hosting service. The <a href="https://opensource.org/osd">Open Source Initiative’s definition</a> describes licensing rights including redistribution and modification; it is not a promise of free computing.</p>
<p>Check the model separately. A downloadable model has its own license and hardware requirements. An open-source application connected to a remote model does not make that remote model open source or move its computation onto your device.</p>
<h2>A practical self-hosted starting point</h2>
<p><a href="https://docs.openclaw.ai/">OpenClaw</a> is an MIT-licensed agent gateway that can run on your own computer or server. It is worth evaluating if you want to operate the agent software yourself. Follow its current setup documentation and test a small task before connecting important accounts.</p>
<p>Use a simple cost worksheet: monthly hosting + model usage + backup storage + maintenance time. For local use, include the cost of any hardware you need to buy. Running on a computer you already own can reduce additional spending, but it does not guarantee the model will be fast enough for your workflow.</p>
<h2>Is Your Agent free?</h2>
<p>The <a href="https://github.com/Milbaxter/sovereign-agent-cloud">Your Agent backend</a> is published under Apache-2.0. The planned managed service is paid: the founding offer is €25 per month for hosting, with inference and applicable taxes separate. This is not an unlimited free AI service. See <a href="/welcome/#pricing">pricing and availability</a> before choosing a route.</p>
<p>If your priority is the lowest cash cost and you are comfortable maintaining software, explore a self-hosted setup first. If your priority is reducing upkeep, compare a managed service using the complete bill and the actual workflow you need.</p>`,
    related: ["local-vs-hosted-ai-agents", "muse-alternative"],
  },
  {
    section: "blog",
    slug: "local-vs-hosted-ai-agents",
    title: "Local AI agents vs self-hosted and managed agents",
    description:
      "Understand where your agent, model and data run, and compare local AI, your own cloud server and managed personal-agent hosting.",
    answer:
      "A local AI agent runs on your device. A self-hosted agent runs on infrastructure you administer, which may be local or in a cloud. A managed agent is operated by a service. In every case, check where model inference happens separately.",
    body: `<h2>One agent, three places to check</h2>
<p>The agent application coordinates tasks. The model processes prompts and produces responses. Storage holds your files, conversation history and memory. These components can run in different places. A desktop agent using a hosted model is a hybrid setup; its interface being local does not make all processing local.</p>
<div class="table-scroll"><table><caption>Tradeoffs between operating models</caption><thead><tr><th scope="col">Setup</th><th scope="col">Useful when</th><th scope="col">What you take on</th></tr></thead><tbody><tr><th scope="row">Local agent and model</th><td>You want computation on your own device.</td><td>Hardware capacity, local backups, updates and availability while the device is awake.</td></tr><tr><th scope="row">Self-hosted cloud agent</th><td>You want your own configuration on an always-on server.</td><td>Server bills, administration and access controls; model processing may still be external.</td></tr><tr><th scope="row">Managed agent</th><td>You want the service to handle operation.</td><td>A service fee and the need to understand operator access, export and provider terms.</td></tr></tbody></table></div>
<h2>Can a personal AI agent run with a local model?</h2>
<p>Yes, when the agent software supports your model server and the model can handle the required tasks. For example, <a href="https://docs.openclaw.ai/providers/ollama">OpenClaw documents an Ollama integration</a>. That is a possible building block, not evidence that every model will reliably use every tool.</p>
<p>Choose a small repeatable test: summarize a folder of notes, find the source of an answer, and make a proposed change for review. Measure whether the result is correct and how long it takes. A model that chats well may still struggle with multi-step tool use. Test with your intended context size and hardware.</p>
<h2>Does local mean offline?</h2>
<p>Not automatically. A local agent can browse the web, use cloud email, sync files or send requests to external APIs. A fully offline workflow needs its model, required data and tools available locally. Download requirements and update checks also need to be considered when evaluating that setup.</p>
<p>Similarly, hosting an agent in Finland identifies the location of that server. It does not establish the processing location of a connected model or email service. Draw the path of a typical task and identify which system receives each piece of information.</p>
<h2>Where Your Agent fits</h2>
<p>Our current offer is being prepared as managed hosting in Finland with external model connections. Complete local operation is a product goal, not a verified offering today. We want a practical path from convenient hosting to infrastructure you control. Read the <a href="/welcome/#faq">current limitations</a> and the <a href="/welcome/blog/portable-ai-memory/">migration checklist</a> when evaluating that promise.</p>`,
    related: ["free-open-source-personal-ai-agent", "grok-bot-alternative"],
  },
  {
    section: "blog",
    slug: "portable-ai-memory",
    title:
      "Portable AI memory: how to keep your context when you change agents",
    description:
      "What an AI memory export should contain, why a chat download is not a working migration, and how to test whether your context survives a move.",
    answer:
      "Portable AI memory is context you can export, understand and reuse in another setup. A complete agent migration goes further: it restores the files, configuration and working behavior needed to continue a real task.",
    body: `<h2>Your history is only one part of memory</h2>
<p>A transcript records what you said. Useful ongoing context also includes the decisions you made, the latest project state, preferences you corrected, and the files those decisions refer to. An export that contains only messages can leave you with substantial reconstruction work.</p>
<p>For a personal research project, for example, the reusable material might be a short project brief, a reading list, notes tied to their sources, and an explanation of which ideas you abandoned. Keeping the explanation alongside the conclusion helps the next agent avoid repeating old mistakes.</p>
<h2>What to look for in an export</h2>
<ul><li><strong>Human-readable context:</strong> preferences, project summaries and current decisions.</li><li><strong>Original files:</strong> documents and attachments with stable names or references.</li><li><strong>Provenance:</strong> where a fact came from and when it was last confirmed.</li><li><strong>Configuration:</strong> instructions, routines and a list of required integrations.</li><li><strong>Format documentation:</strong> a version and an explanation of how the pieces relate.</li></ul>
<p>Markdown, JSON and ordinary files can make inspection easier, but a familiar file extension alone does not establish compatibility. A new system still needs to understand the structure and how to retrieve the right context. Credentials also need a separate recovery plan; a portable memory archive should not casually bundle passwords.</p>
<h2>A five-step migration test</h2>
<ol><li>Choose a project with a known preference, a source file and an unfinished task.</li><li>Export it and check that the expected material is present.</li><li>Restore into a separate environment using documented steps.</li><li>Reconnect only the accounts needed for that task.</li><li>Ask the new agent to continue the work and check its result against the original sources.</li></ol>
<p>Record what moved, what required manual work and what failed. Changing models can change behavior even when the context transfers correctly. A realistic migration promise describes those limits.</p>
<h2>Ownership includes correction and deletion</h2>
<p>Portability is useful during everyday use too. Reading your memory can reveal stale assumptions. Correcting an old preference is often more useful than adding another instruction on top of it. Ask how changes propagate to summaries, indexes and backups, and what deletion actually covers.</p>
<h2>Our current evidence</h2>
<p>Your Agent’s backend includes encrypted export and restore tooling. A complete working-agent migration still needs production acceptance evidence. The <a href="/welcome/sample-export.json">sample export</a> on this site is illustrative, not a live customer export or a verified migration. We intend to publish a repeatable demonstration that shows a task continuing after a move.</p>`,
    related: ["why-personally-owned-ai-agents", "muse-alternative"],
  },
  {
    section: "compare",
    slug: "muse-alternative",
    title: "A Muse alternative for people who want to own their AI agent",
    description:
      "Considering a Meta Muse alternative? Compare software freedom, local operation, memory portability and managed hosting, with clear product limits.",
    answer:
      "If you want a Muse alternative because you value self-hosting and software freedom, evaluate an open-source agent such as OpenClaw. Your Agent is a managed approach being built around that ownership goal; it is not a verified replacement for every Muse feature.",
    body: `<h2>Which Muse are we comparing?</h2>
<p>This page refers to Meta’s personal AI agent Muse, not other products with the same name. In its <a href="https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/">September 2026 announcement</a>, Meta describes an agent that handles tasks, uses a dedicated cloud VM and continues work after the app closes. Meta also says conversations and VM data are not shared with its advertising systems. Ownership should be compared on specific capabilities, not assumptions about a competitor’s privacy.</p>
<h2>Choose the alternative around your reason for switching</h2>
<p>If the problem is a missing integration, test that integration first. If the problem is keeping years of accumulated context, prioritize export and restoration. If your goal is on-device computation, ask where both the agent and model run. These requirements can lead to different choices.</p>
<div class="table-scroll"><table><caption>Questions to ask when evaluating a Muse alternative</caption><thead><tr><th scope="col">Your priority</th><th scope="col">Evidence to request</th><th scope="col">Your Agent today</th></tr></thead><tbody><tr><th scope="row">Software freedom</th><td>A source repository and an explicit license.</td><td>Backend source published under Apache-2.0.</td></tr><tr><th scope="row">Fully local AI</th><td>An end-to-end workflow using a local model and local data.</td><td>A goal; not a verified current offer.</td></tr><tr><th scope="row">Portable context</th><td>An export plus a demonstrated restore.</td><td>Export/restore tooling exists; complete production migration still needs verification.</td></tr><tr><th scope="row">Less maintenance</th><td>Hosting terms, support scope and a full bill.</td><td>Planned managed hosting at €25/month, plus inference and applicable taxes.</td></tr></tbody></table></div>
<h2>Is there a free, open-source Muse alternative?</h2>
<p>Open-source agent software offers a route to building a personal assistant you operate yourself. <a href="https://docs.openclaw.ai/">OpenClaw’s documentation</a> is one starting point. It does not establish feature parity with Muse, and running the software still requires compute and maintenance. Our <a href="/welcome/blog/free-open-source-personal-ai-agent/">guide to free agent costs</a> explains the distinction.</p>
<h2>Use a task as the comparison</h2>
<p>Give each candidate the same small project: read a set of notes, propose next week’s plan, and remember a corrected preference for the next session. Then inspect the stored context and attempt an export. Record quality, effort, cost and what you could reuse elsewhere. A vendor checklist is useful; a successful task and restore provide stronger evidence.</p>
<p>Muse may suit someone who wants its packaged experience. A self-operated agent may suit someone willing to maintain the system to gain control. Your Agent is for people interested in paying for that maintenance while preserving a path toward independence. Check our <a href="/welcome/#faq">release status</a> before relying on that path.</p>
<p class="editorial-note">Editorial comparison by Your Agent. We build one of the products discussed. This is a requirements guide, not a hands-on benchmark or an assertion of missing competitor features. We are not affiliated with Meta.</p>`,
    related: [
      "grok-bot-alternative",
      "why-personally-owned-ai-agents",
      "portable-ai-memory",
    ],
  },
  {
    section: "compare",
    slug: "grok-bot-alternative",
    title: "A Grok Bot alternative with a path to self-hosted AI",
    description:
      "Evaluate Grok Bot alternatives for persistent tasks, model choice and portable context. Understand self-hosted agents and Your Agent’s current scope.",
    answer:
      "For a Grok Bot alternative centered on control, compare where the agent runs, how its context is stored and whether you can restore it elsewhere. Open-source self-hosting is one route. Your Agent is preparing managed hosting with an ownership focus, without claiming Grok Bot feature parity.",
    body: `<h2>What people look for in a Grok Bot alternative</h2>
<p><a href="https://docs.x.ai/grok-bot/overview">Grok Bot’s official overview</a> describes persistent AI teammates using a cloud computer with a browser, files and terminal. It also describes shared context, routines and work that continues while your laptop is closed. This comparison concerns that agent product, rather than a general Grok chat session.</p>
<p>Someone looking for an alternative may want a different model, a different hosting arrangement, or a durable copy of the context behind ongoing work. Those are distinct requirements. A service can be useful and persistent without necessarily matching every preferred operating model.</p>
<h2>Compare continuity as well as task completion</h2>
<div class="table-scroll"><table><caption>A practical evaluation for persistent-agent alternatives</caption><thead><tr><th scope="col">Question</th><th scope="col">A useful test</th></tr></thead><tbody><tr><th scope="row">Does it keep working?</th><td>Schedule a harmless task, close the client and check the result later.</td></tr><tr><th scope="row">Does memory remain accurate?</th><td>Correct a preference and check that the next task uses the correction.</td></tr><tr><th scope="row">Can I change models?</th><td>Run the same tool-using task with a second supported provider.</td></tr><tr><th scope="row">Can I move my work?</th><td>Export a project, restore it in a separate environment and continue it.</td></tr><tr><th scope="row">Who operates the computer?</th><td>Read the hosting and access terms, including model processing locations.</td></tr></tbody></table></div>
<h2>Self-hosting and local operation are different choices</h2>
<p>A self-hosted agent on a rented server can stay available while your laptop sleeps. A local agent depends on the availability of your device. Either can connect to an external model, so the location of the agent alone does not settle the location of inference.</p>
<p>If you need a local model, verify that the software supports your chosen model server and that the model performs your actual workflow reliably. If you need an always-on computer, include server administration and backups in the comparison. Our <a href="/welcome/blog/local-vs-hosted-ai-agents/">local and hosted agent guide</a> lays out the tradeoffs.</p>
<h2>Where Your Agent is different in intent</h2>
<p>We are building around personally controlled context, supported model choice and a practical ability to leave. The backend source is public under Apache-2.0. Managed hosting is planned in Finland, with the founding offer at €25 per month plus inference and applicable taxes. Local operation and a complete production migration still need verification.</p>
<p>That makes Your Agent a project to evaluate for those priorities, not a promise of equivalent multi-agent coordination, integrations or task quality. Start with <a href="/welcome/#how-it-works">the illustrative walkthrough</a>, read <a href="/welcome/#faq">the current boundaries</a>, and use the same task-based comparison when a live account is available.</p>
<p class="editorial-note">Editorial comparison by Your Agent. We build one of the products discussed. This is not a hands-on benchmark, and undocumented capabilities are not treated as absent. We are not affiliated with Grok Bot.</p>`,
    related: [
      "muse-alternative",
      "local-vs-hosted-ai-agents",
      "portable-ai-memory",
    ],
  },
];

export const articlePath = (article: Article) =>
  `/welcome/${article.section}/${article.slug}/`;
