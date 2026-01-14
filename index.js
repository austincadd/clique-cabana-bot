// Load dotenv only when running locally (Railway provides env vars without .env)
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { DateTime } = require("luxon");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ============================
// Config
// ============================
const TZ = process.env.TIMEZONE || "America/New_York";

const DATA_DIR = path.join(__dirname, "data");
const OPTINS_PATH = path.join(DATA_DIR, "optins.json");
const EVENTS_PATH = path.join(__dirname, "events.json");

// Channel IDs
const EVENT_CHANNEL_ID = process.env.EVENT_CHANNEL_ID;     // #upcoming-events (or announcements)
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID; // #welcome

// Slash commands (guild-only during development)
const GUILD_ID = process.env.GUILD_ID;

// ============================
// Helpers: file storage
// ============================
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  if (!fs.existsSync(OPTINS_PATH)) {
    fs.writeFileSync(
      OPTINS_PATH,
      JSON.stringify({ dmOptInUserIds: [] }, null, 2),
      "utf8"
    );
  }
}

function readOptins() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(OPTINS_PATH, "utf8"));
  } catch {
    return { dmOptInUserIds: [] };
  }
}

function writeOptins(data) {
  ensureDataFiles();
  fs.writeFileSync(OPTINS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function readEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

// ============================
// Discord client
// ============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // join events
  ],
});

// ============================
// Copy: Public welcome text (EXACT)
// ============================
const PUBLIC_WELCOME_TEXT =
`Welcome to the Clique Cabana Discord!
This is the home base for our house music family—a collective rooted in Atlanta, built on rhythm, culture, and community. We throw house music events across the city and beyond, bringing together dancers, DJs, creators, and music lovers who live for the groove.
Here you’ll find event announcements, mixes, artist spotlights, and space to connect with like-minded people shaping the sound and culture of Atlanta and surrounding cities. Whether you’re behind the decks, on the dance floor, or just discovering the scene, you’re part of the clique now.
Respect the vibe, support each other, and let the music move you.
Welcome to the Clique 🖤`;

// ============================
// Private personalized DM welcome (culture-first)
// ============================
async function sendPersonalWelcomeDM(member) {
  const displayName = member.displayName || member.user.username;

  const accountAgeDays =
    (Date.now() - member.user.createdAt.getTime()) / (1000 * 60 * 60 * 24);

  let extraLine = "";
  if (accountAgeDays < 30) {
    extraLine =
      "\n\nIf you’re new to Discord or the scene, no stress — ask questions anytime.";
  } else if (accountAgeDays > 365) {
    extraLine =
      "\n\nLooks like you’ve been around for a minute — glad you found your way here.";
  }

  const dm =
`Welcome **${displayName}** 🖤

${PUBLIC_WELCOME_TEXT}${extraLine}`;

  try {
    await member.send(dm);
  } catch {
    // DMs closed — ignore
  }
}

// ============================
// Public welcome in #welcome (one message per join)
// ============================
async function postWelcomeInWelcomeChannel(member) {
  if (!WELCOME_CHANNEL_ID) return;

  const channel = await client.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  // Keep your exact copy, but make it feel like it's addressed to them
  const embed = new EmbedBuilder()
    .setTitle("Welcome to Clique Cabana 🖤")
    .setDescription(PUBLIC_WELCOME_TEXT)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: "Respect the vibe. Support each other. Let the music move you." })
    .setTimestamp();

  // Mention them in a small line, while keeping your text exactly intact in the embed
  await channel.send({
    content: `Welcome ${member} 🖤`,
    embeds: [embed],
  });
}

// ============================
// Pinned text in #upcoming-events (bot posts & pins once)
// ============================
const UPCOMING_EVENTS_PIN_MARKER = "CC_UPCOMING_EVENTS_PIN_V1";

function buildUpcomingEventsPinnedText() {
  // EXACT event list text you requested
  return (
`**Clique Cabana • Upcoming Events**

Clique Cabana Presents: In the Clouds

Friday, February 7
Lee Foss

Friday, February 27
Justin Martin

Friday, March 7
Kyle Walker

—
**How to use this channel**
• Use **/nextevent** to see the next upcoming event (private, just for you)
• Use **/remindme** to get a DM reminder before events
• Reminders post here **24 hours** and **2 hours** before showtime

No spam. No noise. Just what’s next.
See you in the clouds 🖤

${UPCOMING_EVENTS_PIN_MARKER}`
  );
}

async function ensurePinnedUpcomingEventsMessage() {
  if (!EVENT_CHANNEL_ID) return;

  const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Requires Manage Messages permission to fetch pins and pin messages
  const pins = await channel.messages.fetchPinned().catch(() => null);
  if (pins) {
    const alreadyPinned = pins.find(
      (m) => m.author?.id === client.user.id && m.content?.includes(UPCOMING_EVENTS_PIN_MARKER)
    );
    if (alreadyPinned) return; // done
  }

  // Not found -> post & pin
  const msg = await channel.send(buildUpcomingEventsPinnedText());
  await msg.pin().catch(() => {
    console.log("⚠️ Could not pin message (missing Manage Messages permission).");
  });
}

// ============================
// Slash commands: /nextevent, /remindme, /remindoff
// ============================
async function registerSlashCommands() {
  if (!GUILD_ID) {
    console.log("⚠️ GUILD_ID not set — skipping slash command registration.");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("nextevent")
      .setDescription("Show the next Clique Cabana event"),

    new SlashCommandBuilder()
      .setName("remindme")
      .setDescription("Opt in to DM reminders for events"),

    new SlashCommandBuilder()
      .setName("remindoff")
      .setDescription("Opt out of DM reminders for events"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );

  console.log("✅ Slash commands registered for guild:", GUILD_ID);
}

function getNextEvent(events) {
  const now = DateTime.now().setZone(TZ);

  const upcoming = events
    .map((e) => ({
      ...e,
      dt: DateTime.fromISO(e.startISO, { zone: TZ }),
    }))
    .filter((e) => e.dt.isValid && e.dt > now)
    .sort((a, b) => a.dt.toMillis() - b.dt.toMillis());

  return upcoming[0] || null;
}

function formatEventEmbed(event) {
  const dt = DateTime.fromISO(event.startISO, { zone: TZ });

  const embed = new EmbedBuilder()
    .setTitle(event.title || "Clique Cabana Event")
    .setDescription(event.description || "House music family 🖤")
    .addFields(
      { name: "When", value: dt.toFormat("cccc, LLLL d • h:mm a ZZZZ"), inline: false },
      { name: "Where", value: event.location || "TBA", inline: false }
    )
    .setTimestamp(new Date(dt.toISO()))
    .setFooter({ text: "Clique Cabana" });

  if (event.link) embed.addFields({ name: "Link", value: event.link, inline: false });
  if (event.imageUrl) embed.setImage(event.imageUrl);

  return embed;
}

// ============================
// Reminder engine
// - Posts to EVENT_CHANNEL_ID
// - DMs opt-ins
// ============================
const reminderState = new Set();

async function runReminderCheck() {
  const events = readEvents();
  const next = getNextEvent(events);
  if (!next) return;

  if (!EVENT_CHANNEL_ID) return;

  const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now = DateTime.now().setZone(TZ);
  const start = DateTime.fromISO(next.startISO, { zone: TZ });

  const minutesUntil = Math.round(start.diff(now, "minutes").minutes);

  // Reminder windows
  const windows = [
    { label: "24h", minutes: 24 * 60, message: "⏳ **24 hours** until the next Clique Cabana." },
    { label: "2h", minutes: 2 * 60, message: "🔥 **2 hours** until Clique Cabana. See you on the floor." },
  ];

  for (const w of windows) {
    const key = `${next.id}:${w.label}`;

    // Trigger within a small window to avoid missing due to timing
    const shouldTrigger = Math.abs(minutesUntil - w.minutes) <= 1;

    if (shouldTrigger && !reminderState.has(key)) {
      reminderState.add(key);

      const embed = formatEventEmbed(next);
      await channel.send({ content: w.message, embeds: [embed] });

      // DM opt-ins
      const optins = readOptins();
      const ids = optins.dmOptInUserIds || [];
      if (ids.length) {
        for (const userId of ids) {
          const user = await client.users.fetch(userId).catch(() => null);
          if (!user) continue;

          try {
            await user.send(
              `${w.message}\n\n` +
              `**${next.title}**\n` +
              `${start.toFormat("cccc, LLL d • h:mm a")}\n` +
              `${next.location || "TBA"}` +
              (next.link ? `\n${next.link}` : "")
            );
          } catch {
            // DMs closed
          }
        }
      }
    }
  }
}

// ============================
// Bot lifecycle
// ============================
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  await registerSlashCommands();
  await ensurePinnedUpcomingEventsMessage();

  // Every minute reminder loop
  cron.schedule("* * * * *", async () => {
    await runReminderCheck();
  });

  console.log("✅ Reminder engine running (every minute).");
});

client.on("guildMemberAdd", async (member) => {
  // 1) Public welcome in #welcome (your requested text)
  await postWelcomeInWelcomeChannel(member);

  // 2) Private DM welcome (personalized)
  await sendPersonalWelcomeDM(member);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const events = readEvents();
  const next = getNextEvent(events);

  if (interaction.commandName === "nextevent") {
    if (!next) {
      await interaction.reply({ content: "No upcoming events listed yet 🖤", ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [formatEventEmbed(next)], ephemeral: true });
    return;
  }

  if (interaction.commandName === "remindme") {
    const optins = readOptins();
    const set = new Set(optins.dmOptInUserIds || []);
    set.add(interaction.user.id);
    optins.dmOptInUserIds = Array.from(set);
    writeOptins(optins);

    await interaction.reply({
      content: "✅ You’re opted in. I’ll DM you reminders before events.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "remindoff") {
    const optins = readOptins();
    optins.dmOptInUserIds = (optins.dmOptInUserIds || []).filter(
      (id) => id !== interaction.user.id
    );
    writeOptins(optins);

    await interaction.reply({
      content: "✅ Opted out. You won’t receive event reminder DMs.",
      ephemeral: true,
    });
    return;
  }
});

client.login(process.env.BOT_TOKEN);
