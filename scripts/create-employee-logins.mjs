/**
 * Login accounts for employees who do not have one.
 *
 * Dry-run by default: it prints the whole plan and writes nothing. Only
 * `--apply` writes, and `--apply` refuses to start without a verified database
 * dump named on the command line.
 *
 *   npx dotenv -e .env -- npx tsx scripts/create-employee-logins.mjs
 *   npx dotenv -e .env -- npx tsx scripts/create-employee-logins.mjs \
 *     --apply --confirm create-production-logins \
 *     --backup backups/hrms_prod-prelogins-<stamp>.dump
 *
 * Writing needs THREE things together - `--apply`, the confirmation phrase
 * spelled out, and a dump that this script has read the table of contents of.
 * Anything it does not recognise on the command line is a hard error rather
 * than an ignored token.
 *
 * What it touches, exhaustively:
 *   - INSERT into `users`      - one row per employee that qualifies
 *   - INSERT into `user_roles` - the EMPLOYEE role, one row per new user
 *   - INSERT into `audit_logs` - one row per new user
 *   - UPDATE `employees.userId` - the link to the account, and NOTHING else
 *
 * That last one is the only write to the employee table and it is deliberate:
 * `employees.userId` is the account link itself, not profile data. No name,
 * email, number, salary, shift, punch code or any other employee field is read
 * back and written, here or anywhere below. An employee row that already has a
 * `userId` is never touched.
 *
 * What it never touches: existing users of any kind, roles, permissions,
 * attendance, payroll, leave, loans, punch codes, raw punches.
 *
 * Decisions this encodes, all of which show up in the dry-run before they cost
 * anything:
 *
 *   - The login is the employee's own `workEmail`, lower-cased and trimmed the
 *     way `userCreateSchema` and `loginSchema` already normalise it, so the
 *     address stored is the address somebody can type. `personalEmail` is NOT
 *     used unless `--allow-personal-email` says so: a private gmail address is
 *     a different decision from a company one and should be taken on purpose.
 *
 *   - `employeeNumber` and punch codes are never used as a login. They are not
 *     email addresses and the column is unique across the whole table.
 *
 *   - Only employees whose status is ACTIVE. A terminated or resigned person is
 *     not a current employee, and `users.routes.ts` refuses them a login too.
 *     Any other status is reported for a person to decide, never assumed.
 *
 *   - An address that is already on a `users` row - anybody's - disqualifies
 *     the employee. The column is unique company-wide, so the alternative is a
 *     failed insert half way through a run.
 *
 *   - Two employees sharing one address disqualifies BOTH. One of them would
 *     otherwise silently take the address and the other would silently lose it,
 *     and this script has no way to know which was meant.
 *
 *   - New accounts are ACTIVE with `mustChangePassword` set. ACTIVE because
 *     `authenticate()` rejects every other status, so an INVITED account cannot
 *     use the passphrase this script generates; the flag is what marks the
 *     passphrase as temporary.
 *
 *   - The passphrase is hashed with the application's own `hashPassword` -
 *     imported from `apps/api/src/auth/password.ts`, not reimplemented - so
 *     there is one Argon2id configuration in this system and these accounts
 *     sign in through exactly the code path everybody else does. The plaintext
 *     never reaches the database; it is written once to a 0600 file for the
 *     operator to distribute.
 */
import { randomInt } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../apps/api/src/auth/password.js';

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

/**
 * Every flag this script understands.
 *
 * Checked, not merely documented. A typo'd or invented flag is a hard error
 * rather than a silent no-op, because a no-op flag sitting beside `--apply`
 * reads like a safety net and is not one: this script has already once been run
 * against production by somebody who believed `--dry-run-guard-test` would stop
 * it. Unknown input stops the run before a single row is read.
 */
const KNOWN_FLAGS = new Set([
  '--apply', '--confirm', '--backup', '--plan', '--allow-personal-email',
  '--allow-suspicious-domains', '--with-digit', '--role', '--out', '--db-container',
]);
const TAKES_VALUE = new Set(['--backup', '--plan', '--role', '--out', '--db-container']);

for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (!token.startsWith('--')) continue;
  if (!KNOWN_FLAGS.has(token)) {
    console.error(`Unknown option "${token}".`);
    console.error(`Known options: ${[...KNOWN_FLAGS].join(' ')}`);
    process.exit(2);
  }
  if (TAKES_VALUE.has(token)) i += 1;
}

/**
 * The phrase that has to be typed out in full beside `--apply`.
 *
 * Two independent things the operator must do on purpose, neither of which can
 * be reached by adding a plausible-looking flag to a command line.
 */
const CONFIRM_PHRASE = 'create-production-logins';

const APPLY = flag('--apply');
const BACKUP = value('--backup');
const ALLOW_PERSONAL = flag('--allow-personal-email');
/** Create anyway on a domain that looks like a typo of a far commoner one. */
const ALLOW_SUSPICIOUS = flag('--allow-suspicious-domains');
/** Adds a two-digit number, for the house policy's "include a number" rule. */
const WITH_DIGIT = flag('--with-digit');
const ROLE_KEY = value('--role') ?? 'EMPLOYEE';
/** Where `pg_restore` can be found when the host has no Postgres client. */
const DB_CONTAINER = value('--db-container') ?? 'hrms-db';
const OUT = value('--out') ?? `credentials/employee-logins-${stamp()}.csv`;
/** The approved plan: written by a dry run, required by `--apply`. */
const PLAN_IN = value('--plan');
const PLAN_OUT = `credentials/login-plan-${stamp()}.json`;

function stamp() {
  const [date, time] = new Date().toISOString().split('T');
  return `${date.replace(/-/g, '')}-${time.slice(0, 8).replace(/:/g, '')}`;
}

// ------------------------------------------------------------------ passwords

/**
 * The passphrase vocabulary.
 *
 * Short, common, unambiguous English words: nothing homophonous, nothing that
 * has to be spelled out over a phone, no plurals sitting next to their
 * singulars. The list is de-duplicated and counted at startup rather than
 * trusted, because a typo that repeats a word silently costs entropy and a
 * silent loss of entropy is the one failure this would never show.
 */
const WORDS = [...new Set(
  `
  able acid acorn actor adapt add adobe adopt adult aflame afraid again agent agile
  agree ahead aid aim air alarm album alert alien alike alive alley allow almond aloe
  alone along aloud alpha also alter amber amble amend amid ample amuse anchor angel
  anger angle animal ankle annual answer ant anthem anvil anyone apart apex apple
  april apron arcade arch arctic area arena argue arise arm armor army aroma arrow art
  ashen aside ask aspen asset atlas atom attic auburn audio audit august aunt author
  auto autumn avenue avoid awake award aware away awning axis
  baby back bacon badge bagel baker balance balcony bald ballad balloon bamboo banana
  band banjo bank banner barn barrel base basil basin basket bass batch bath baton bay
  beach beacon bead beam bean bear beat beaver bed beech beef beetle begin behave
  behind being belfry bell belong belt bench bend berry beside best beta better beyond
  bicycle bid big bike bill binary birch bird birth biscuit bishop bison bit bitter
  black blade blanket blast blaze blend bless blind blink block bloom blossom blue
  blush board boat body boil bold bolt bonnet bonus book boost boot border born borrow
  bother bottle bottom boulder bounce bound bow bowl box boy brace braid brain brake
  branch brand brass brave bread break breeze brick bridge brief bright bring brisk
  broad broil broken bronze brook broom brother brown brush bubble bucket buckle bud
  budget buffet bugle build bulb bulk bull bundle bunk burden burn burst bus bush
  business busy butter button buy buzz
  cabin cable cactus cadet cage cake calm camel camera camp canal candle candy cane
  canoe canvas canyon cap cape captain car carbon card care cargo carpet carrot cart
  carve case cash cask cast castle cat catch cattle cause cave cedar ceiling cell
  cement census cent center ceramic cereal chain chair chalk champ chance change
  channel chant chapel charm chart chase cheap check cheer cheese chef cherry chess
  chest chew chief child chill chimney chin chip chirp chisel choice choose chop
  chorus chosen chrome chunk church cider cigar cinema circle circus citizen city
  civic civil claim clam clap clarity clash class clay clean clear clerk clever cliff
  climb cling clinic clip cloak clock close cloth cloud clover club clump cluster
  clutch coach coal coast coat cobalt cocoa code coffee coil coin cold collar colony
  color colt column comb combine come comet comfort comic common compact compass
  compete concert concrete condor cone confirm connect consent console constant
  contact contest control convert cook cool copper copy coral cord core cork corn
  corner correct corridor cost cottage cotton couch cough count county couple courage
  course court cousin cover cow crab crack cradle craft crane crash crate crawl crayon
  cream create credit creek crest crew cricket crimson crisp critic crop cross crowd
  crown crumb crush crust cry crystal cube cuckoo cue cuff culture cup curb cure
  curious curl current curtain curve cushion custom cut cycle cypress
  dagger daily dairy daisy dam damp dance danger dare dark dart dash data date dawn
  day deal dear debate debris decade decide deck decor deep deer defend define degree
  delay delta demand denim dense dental deny depart depend deposit depth derby desert
  design desk detail detect device devote dial diamond diary dice diesel diet differ
  dig digital dignity dim dine dinner direct dirt disc dish disk dismiss display
  distance ditch dive divide dock doctor dodge dog dollar dolphin dome donate donkey
  door dose dot double dough dove down dozen draft drag dragon drain drama draw dream
  dress drift drill drink drive drop drum dry duck duel duet dull dune dusk dust duty
  dwarf dwell dye dynamo
  eager eagle ear early earn earth ease east easy eat echo eclipse edge edit effort
  egg eight elbow elder elect electric elegant element elephant eleven elite elm
  embark ember emblem embrace emerald emerge emit empire employ empty enable enact
  enamel enchant end endure enemy energy engage engine enjoy enlist enough enrich
  ensure enter entire entry envelope equal equip era erase errand error escape essay
  estate etch eternal ethics evening event ever every evidence exact exam example
  exceed excite exhale exist exit expand expect expert explain export express extend
  extra eye
  fabric face fact factor fade fair fairy faith falcon fall false fame family famous
  fan fancy far farm fashion fast fasten fatal father fault favor fawn fear feast
  feather fee feed feel fellow felt fence fern ferry fetch fever few fiber fiction
  field fierce fifteen fifty fig fight figure file fill film filter final finch find
  fine finger finish fir fire firm first fish fist fit five fix flag flame flare flash
  flat flavor flax fleet flesh flex flight flint flip float flock flood floor flour
  flow flower fluid flute fly foam focus fog foil fold folk follow fond food fool foot
  force forest forever forge fork form fort forty forum forward fossil foster found
  four fox frame free freeze fresh friend fringe frog from front frost frown frozen
  fruit fuel full fun fund funny fur furnace future
  gadget gain galaxy gallery gallon game gap garage garden garlic garment gas gate
  gather gauge gaze gear gem general gentle genuine gesture ghost giant gift ginger
  giraffe girl give glacier glad glance glass glaze gleam glide glimpse globe gloom
  glory glove glow glue goal goat gold golf good goose gorge gown grab grace grade
  grain grand granite grant grape graph grasp grass grave gravel gray great green
  greet grid grief grill grin grip grit grocery groom groove ground group grove grow
  guard guess guest guide guild guitar gulf gull gum gust gym
  habit hail hair half hall halt hammer hamster hand handle hang happy harbor hard
  hare harm harp harvest hat hatch hawk hazel head heal health heap hear heart heat
  heavy hedge heel height helm help hen herb herd here hero hidden hide high hill hint
  hip hire history hive hobby hockey hold hole hollow holy home honest honey hood hoof
  hook hope horizon horn horse hose host hotel hour house hover howl hub huge human
  humble humid humor hundred hunger hunt hurdle hurry hurt husk hut hybrid hymn
  ice icon idea ideal idle igloo ill image impact imply import impose impulse inch
  include income indeed index indoor infant inform inherit initial ink inlet inner
  input insect inside insist inspect install instant intact intend invest invite iris
  iron island issue item ivory ivy
  jacket jade jaguar jam jar jaw jazz jeans jelly jet jewel job jog join joint joke
  jolly journal journey joy judge juice july jump june jungle junior jury just
  kayak keen keep kennel kernel kettle key kick kid kidney kind king kiss kit kitchen
  kite kitten knee kneel knife knight knit knob knock knot know
  lab label labor lace ladder lady lake lamb lamp land lane language lantern lap large
  laser last latch late later laugh launch laundry lava law lawn layer lazy lead leaf
  league lean leap learn lease leash least leather leave lecture ledge left leg legacy
  legal legend lemon lend length lens leopard lesson let letter level liberty library
  license lid life lift light like lilac lily limb lime limit line linen link lion lip
  liquid list listen liter little live lizard load loaf loan lobby local lock lodge
  loft log logic lonely long look loop loose lord lose loss lost lot loud lounge love
  low loyal luck lumber lunar lunch lung luxury lyric
  machine mad magic magnet maid mail main major make mammal man manage mango manor
  mantle manual maple marble march margin marine mark market marsh mask mason mast
  master match mate math matrix matter mature maze meadow meal mean measure meat medal
  media medium meet melody melon melt member memory mend mention menu mercy merge
  merit merry mesh message metal meteor method middle midnight might mild mile milk
  mill mind mine mineral mingle mint minute mirror miss mist mix mobile model modern
  modest moist mold moment monarch money monitor monkey month moon moral more morning
  mortal mosaic moss most motel moth mother motion motor mount mouse mouth move movie
  much mud muffin mule multiply muscle museum music must mustard mutual myself mystery
  nail name napkin narrow nation native nature navy near neat neck need needle
  neighbor neon nerve nest net network neutral never new news next nice niche nickel
  night nine noble nod noise noon normal north nose note notice novel november now
  nozzle number nurse nut
  oak oar oasis oat obey object oblige observe obtain occupy occur ocean october odd
  odor offer office often oil olive omega once onion online only onto open opera
  opinion oppose option orange orbit orchard order organ origin ornate orphan ostrich
  other otter ounce out oval oven over owl own oxygen oyster
  pace pack pad page paint pair palace pale palm pan panda panel panic pants paper
  parade parcel pardon parent park parrot parsley part party pass past pasta pastel
  patch path patient patrol pattern pause pave paw pay peace peach peak peanut pear
  pearl pebble pecan pedal peel peer pelican pen pencil penguin people pepper perch
  perfect perform perhaps period permit person pest petal phase phone photo phrase
  piano pick picnic picture pie piece pier pigeon pile pilgrim pillar pillow pilot pin
  pinch pine pink pint pioneer pipe pistol pit pitch pity pixel pizza place plain plan
  planet plank plant plaster plastic plate play plaza pleasant please pledge plenty
  plot plow plug plum plunge plus pocket poem poet point polar pole police polish
  polite pond pony pool poplar poppy popular porch pork port portion pose position
  possible post pot potato pottery pouch pound pour powder power praise prank prawn
  pray precise prefer premium prepare present press pretty prevent price pride prime
  print prior prism prison private prize problem proceed produce profile program
  project promise proof proper protect proud prove provide public pudding puff pull
  pulse pump punch pupil puppy pure purple purpose purse push put puzzle pyramid
  quail quaint quality quarry quarter queen query quest question queue quick quiet
  quilt quit quiz quota quote
  rabbit raccoon race rack radar radio radish raft rag rail rain raise rake rally ramp
  ranch random range rank rapid rare rate rather ratio raven raw ray reach read ready
  real reason rebel recall receive recent recipe record recover red reduce reed reef
  refer reflect refuge refuse regard region regret regular reject rejoice relax relay
  release relief rely remain remark remedy remind remote remove render renew rent
  repair repeat reply report request require rescue research reserve resist resolve
  resort respect respond rest result retail retire return reveal review reward
  rhythm rib ribbon rice rich ride ridge rifle right rigid rim ring rinse ripe ripple
  rise risk ritual rival river road roam roar roast robe robin robot rock rocket rod
  rogue role roll roof room root rope rose rotate rough round route routine row royal
  rubber ruby rug rule ruler rumor run runner rural rush rust
  sack sacred sad saddle safe sage sail saint salad salmon salon salt salute same
  sample sand sandal sauce sausage save saw say scale scan scar scarf scatter scene
  scent school science scissors scoop scope score scout scrap screen script scroll
  sculpt sea seal search season seat second secret section secure seed seek seem
  segment select self sell senate send senior sense sentence series serious serve
  session settle seven sever shade shadow shaft shake shallow shame shape share shark
  sharp shed sheep sheet shelf shell shelter shield shift shine ship shirt shiver
  shock shoe shoot shop shore short should shoulder shout shovel show shower shrimp
  shrub shuffle shut shy sibling side siege sigh sight sign signal silent silk silly
  silver similar simple since sing single sink sir sister sit site six size skate
  sketch ski skill skin skip skirt skull sky slab slam sleep sleeve slender slice
  slide slight slim slip slogan slope slot slow small smart smell smile smoke smooth
  snack snail snake snap sneak snow soap soccer social sock soda soft soil solar
  soldier solid solve some son song soon sorry sort soul sound soup source south space
  spare spark speak special speech speed spell spend sphere spice spider spike spill
  spin spirit split spoke sponge spoon sport spot spray spread spring sprout spruce
  spur spy square squash squeeze squid stable stack staff stage stairs stamp stand
  star start state station statue stay steady steak steam steel steep steer stem step
  stick stiff still sting stir stock stone stool stop store storm story stove straight
  strain strand strap straw stream street stress stretch strike string strip stroke
  strong studio study stuff style subject submit subway succeed such sudden suffer
  sugar suggest suit summer summit sun sunny sunset super supply support suppose
  supreme sure surf surface surge surprise survey survive suspect sustain swallow swan
  swap swarm sweat sweep sweet swell swift swim swing switch sword symbol syrup system
  table tackle tag tail tailor take tale talent talk tall tandem tank tape target task
  taste tattoo tax taxi tea teach team tear tease tech teeth tell temple ten tenant
  tend tennis tense tent term test text than thank that theme theory there thick thief
  thin thing think third thirty this thorn those thread three thrive throat throne
  through throw thumb thunder ticket tide tidy tie tiger tight tile till timber time
  tin tiny tip tire title toast today toe together toilet token toll tomato tone tongs
  tonight tool tooth top topic torch total touch tough tour toward towel tower town
  toy trace track trade traffic trail train trait tram trap travel tray treat tree
  trend trial tribe trick trim trip triumph trolley troop trophy trouble truck true
  trumpet trunk trust truth try tube tuck tulip tumble tuna tune tunnel turkey turn
  turtle twelve twenty twice twig twin twist two type
  ugly umbrella uncle under undo unfold unify union unique unit unite universe unlock
  until unusual upon upper upset urban urge usage use useful usual utility
  vacant vacuum vague valid valley value valve van vanilla vapor variety vase vast
  vault vector velvet vendor venture venue verb verdict verse version vessel veteran
  vibrant victory video view village vine vinyl violet violin virtue visa visible
  vision visit vital vivid vocal voice void volcano volume vote voyage
  wade wafer wage wagon waist wait wake walk wall walnut wander want war wardrobe
  warm warn warrant wash wasp waste watch water wave wax way weak wealth weapon wear
  weather weave web wedge week weigh weird welcome weld well west wet whale wheat
  wheel when where which while whisper whistle white whole why wide widow width wild
  will willow win wind window wine wing wink winter wipe wire wisdom wise wish wit
  witness wizard wolf woman wonder wood wool word work world worm worry worth wound
  woven wrap wreath wrench wrist write wrong
  yard yarn yawn year yeast yellow yes yet yield yoga yogurt yolk you young
  zebra zenith zero zest zigzag zinc zone zoo
  `.trim().split(/\s+/),
)].sort();

if (WORDS.length < 1024) {
  throw new Error(`Wordlist is only ${WORDS.length} words; refusing to weaken the passphrases.`);
}

const WORD_COUNT = 8;
const BITS_PER_WORD = Math.log2(WORDS.length);

/**
 * One passphrase: exactly eight words, chosen with the CSPRNG.
 *
 * `randomInt` and not `Math.random`, and a fresh draw per word rather than one
 * shuffled slice, so every word is independent. Words may repeat - forbidding
 * repeats would REMOVE entropy, not add it, and at this list length the odds
 * are negligible anyway.
 */
function passphrase() {
  const picked = [];
  for (let i = 0; i < WORD_COUNT; i += 1) picked.push(WORDS[randomInt(WORDS.length)]);
  const words = picked.join('-');
  // Off by default: the brief says eight words and nothing else. On, it satisfies
  // the house passwordSchema's "include at least one number" rule as well.
  return WITH_DIGIT ? `${words}-${String(randomInt(10, 100))}` : words;
}

// --------------------------------------------------------------- email checks

/**
 * The same shape `userCreateSchema` accepts, applied here so the preview cannot
 * promise an address the application would later reject. Trim and lower-case
 * because that is what `loginSchema` does to whatever somebody types - store it
 * any other way and the address on the row is not the address they can sign in
 * with.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Reserved by RFC 2606/6761: these resolve nowhere and are never a real login. */
const RESERVED_TLDS = new Set(['invalid', 'test', 'example', 'localhost', 'local']);

/**
 * Edit distance, capped at 3 because nothing further is a typo worth guessing.
 */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Domains that look like a slip of the finger on a domain almost everybody else
 * is on.
 *
 * "gamempieres.com" beside fifty-two "gamempires.com" is not a second company,
 * and neither this script nor anybody reading its output can prove that from
 * the database - which is exactly why it is REPORTED rather than corrected.
 * Built from the data in hand, not from a list of domains kept in the source,
 * so a company that adds a domain next year needs no edit here.
 */
function nearMissDomains(addresses) {
  const freq = new Map();
  for (const a of addresses) {
    const d = a.split('@')[1];
    if (d) freq.set(d, (freq.get(d) ?? 0) + 1);
  }
  const common = [...freq.entries()].filter(([, n]) => n >= 5).sort((x, y) => y[1] - x[1]);
  const suspect = new Map();
  for (const [domain, n] of freq) {
    for (const [candidate, cn] of common) {
      if (domain === candidate) continue;
      // Ten times as many people on the other one, and one or two characters
      // apart: that is a typo, not a second domain.
      if (cn >= n * 10 && editDistance(domain, candidate) <= 2) {
        suspect.set(domain, candidate);
        break;
      }
    }
  }
  return suspect;
}

function checkEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) return { email: null, problem: 'missing' };
  if (email.length > 254) return { email, problem: 'too long' };
  if (!EMAIL_RE.test(email)) return { email, problem: 'not a valid address' };

  const domain = email.split('@')[1];
  const tld = domain.split('.').pop();
  if (RESERVED_TLDS.has(tld)) return { email, problem: `reserved domain .${tld}` };
  // A domain ending in a digit is not illegal, but "gamempires.com1" is a typo
  // every time, and a login nobody can receive mail at is worth a human look.
  if (/\d$/.test(tld)) return { email, problem: `suspicious domain ${domain}` };

  return { email, problem: null };
}

// ------------------------------------------------------------------------ plan

/**
 * The bridge between "I approve this list" and "create this list".
 *
 * Holds the employee, the address and the passphrase for every row the dry run
 * showed. Plaintext, necessarily - it is the sheet somebody is going to hand
 * out - so 0600, and it should be deleted once the passwords have been
 * distributed. It never goes near the database; only the Argon2id hash does.
 */
function writePlan(file, list, byId) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    generatedAt: new Date().toISOString(),
    wordCount: WORD_COUNT,
    wordlistSize: WORDS.length,
    entries: list.map((r) => ({
      employeeId: r.id,
      employeeNumber: r.number,
      name: r.name,
      email: r.email,
      password: byId.get(r.id),
    })),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Read an approved plan back, and refuse it if the world has moved.
 *
 * The database is re-read on every run, so a plan approved this morning may no
 * longer describe what is there: somebody may have been given a login by hand,
 * had their address corrected, or left. Rather than quietly creating a
 * different set from the one that was approved, any disagreement stops the run
 * and says which employee it is about.
 */
function readPlan(file, list) {
  if (!existsSync(file)) throw new Error(`Plan not found: ${file}`);
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const entries = body.entries ?? [];

  const byEmployee = new Map();
  const seenPasswords = new Set();
  for (const e of entries) {
    if (!e.password || e.password.split('-').filter((w) => /^[a-z]+$/.test(w)).length < WORD_COUNT) {
      throw new Error(`Plan entry for ${e.email} does not carry a ${WORD_COUNT}-word passphrase.`);
    }
    if (seenPasswords.has(e.password)) throw new Error('Plan repeats a passphrase; aborting.');
    seenPasswords.add(e.password);
    byEmployee.set(e.employeeId, e.password);
  }

  const planned = new Set(entries.map((e) => e.employeeId));
  const current = new Set(list.map((r) => r.id));

  const added = list.filter((r) => !planned.has(r.id));
  const gone = entries.filter((e) => !current.has(e.employeeId));
  if (added.length || gone.length) {
    const lines = [
      `Plan no longer matches the database: ${file}`,
      ...added.map((r) => `  now eligible but not in the plan: ${r.number} ${r.name} <${r.email}>`),
      ...gone.map((e) => `  in the plan but no longer eligible: ${e.employeeNumber} ${e.name} <${e.email}>`),
      'Re-run the dry run, read the new list, and approve that.',
    ];
    throw new Error(lines.join('\n'));
  }

  for (const r of list) {
    const e = entries.find((x) => x.employeeId === r.id);
    if (e.email !== r.email) {
      throw new Error(`Address changed since the plan for ${r.number}: ${e.email} -> ${r.email}. Re-run the dry run.`);
    }
  }

  console.log(`using approved plan ${file} (${entries.length} entries, generated ${body.generatedAt})\n`);
  return { byEmployee };
}

// ---------------------------------------------------------------------- backup

/**
 * Proof that a dump exists, is not empty, and actually contains the two tables
 * this script writes to.
 *
 * `pg_restore -l` reads the dump's own table of contents, so this is a check on
 * the file rather than on the operator's memory of having made it. A backup
 * that cannot be listed is not a backup.
 */
function verifyBackup(file) {
  if (!file) throw new Error('--apply requires --backup <dump file>. Take one first.');
  if (!existsSync(file)) throw new Error(`Backup not found: ${file}`);

  const { size, mtime } = statSync(file);
  if (size < 100_000) throw new Error(`Backup looks truncated (${size} bytes): ${file}`);

  /**
   * Listed with a real `pg_restore`, wherever one lives.
   *
   * The host has no Postgres client - the database runs in a container - so the
   * archive is read by the container's own binary, at the same version that
   * wrote it. Copied in rather than piped: a custom-format dump has to be
   * seekable, and `pg_restore -l` on a pipe fails with "did not find magic
   * string in file header", which reads like a corrupt backup when it is only
   * a corrupt way of asking.
   */
  let toc;
  try {
    toc = execFileSync('pg_restore', ['-l', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    try {
      execFileSync('docker', ['cp', file, `${DB_CONTAINER}:/tmp/verify-backup.dump`]);
      toc = execFileSync(
        'docker',
        ['exec', DB_CONTAINER, 'pg_restore', '-l', '/tmp/verify-backup.dump'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (err) {
      throw new Error(`Backup is not a readable pg_dump archive: ${file}\n${err.message}`);
    } finally {
      try {
        execFileSync('docker', ['exec', DB_CONTAINER, 'rm', '-f', '/tmp/verify-backup.dump']);
      } catch {
        // The copy is a scratch file in a container; failing to tidy it is not
        // a reason to refuse a backup that has already been read successfully.
      }
    }
  }
  for (const table of ['users', 'user_roles', 'employees']) {
    if (!new RegExp(`TABLE DATA public ${table} `).test(toc)) {
      throw new Error(`Backup has no data for "${table}": ${file}`);
    }
  }

  const ageMinutes = Math.round((Date.now() - mtime.getTime()) / 60_000);
  console.log(`backup verified: ${file}`);
  console.log(`  ${(size / 1_048_576).toFixed(1)} MB, taken ${ageMinutes} minute(s) ago, ${toc.split('\n').length} archive entries\n`);
}

// ------------------------------------------------------------------------ main

const company = await prisma.company.findFirstOrThrow({ select: { id: true, name: true } });

const role = await prisma.role.findFirst({
  where: { companyId: company.id, key: ROLE_KEY },
  select: { id: true, key: true, name: true, dataScope: true },
});
if (!role) throw new Error(`No role with key "${ROLE_KEY}" in ${company.name}.`);

const employees = await prisma.employee.findMany({
  where: { companyId: company.id },
  select: {
    id: true, employeeNumber: true, firstName: true, lastName: true, displayName: true,
    workEmail: true, personalEmail: true, status: true, userId: true,
  },
  orderBy: [{ employeeNumber: 'asc' }],
});

/** Every address already spoken for, so a run cannot collide with one. */
const takenRows = await prisma.user.findMany({ select: { email: true } });
const taken = new Set(takenRows.map((u) => u.email.trim().toLowerCase()));

const name = (e) => e.displayName?.trim() || `${e.firstName} ${e.lastName}`.trim();

// First pass: resolve an address and a verdict for every employee.
const rows = employees.map((e) => {
  const source = e.workEmail?.trim() ? 'work' : ALLOW_PERSONAL && e.personalEmail?.trim() ? 'personal' : 'work';
  const raw = source === 'personal' ? e.personalEmail : e.workEmail;
  const { email, problem } = checkEmail(raw);

  const row = {
    id: e.id, number: e.employeeNumber, name: name(e), status: e.status,
    email, source, hasAccount: Boolean(e.userId), create: false, reason: null,
  };

  if (e.userId) { row.reason = 'already has a login'; return row; }
  if (e.status !== 'ACTIVE') { row.reason = `not a current employee (${e.status})`; return row; }
  if (problem === 'missing' && !ALLOW_PERSONAL && e.personalEmail?.trim()) {
    row.reason = 'only a personal email on file (use --allow-personal-email)';
    return row;
  }
  if (problem) { row.reason = `email ${problem}`; return row; }
  if (taken.has(email)) { row.reason = 'email already belongs to an account'; return row; }

  row.create = true;
  return row;
});

/**
 * The typo pass, run over the addresses that survived everything else.
 *
 * Blocked by default rather than waved through: an account is easy to add later
 * and awkward to unpick, and a login on an address nobody can receive mail at
 * is a support call waiting to happen. `--allow-suspicious-domains` says "yes,
 * I looked, create them anyway".
 */
const nearMiss = nearMissDomains(rows.filter((r) => r.create).map((r) => r.email));
for (const r of rows) {
  if (!r.create) continue;
  const domain = r.email.split('@')[1];
  const meant = nearMiss.get(domain);
  if (!meant) continue;
  r.suspect = `${domain} - did you mean ${meant}?`;
  if (!ALLOW_SUSPICIOUS) {
    r.create = false;
    r.reason = `email suspicious domain (${r.suspect})`;
  }
}

// Second pass: an address claimed by two employees disqualifies both.
const seen = new Map();
for (const r of rows) {
  if (!r.create) continue;
  const list = seen.get(r.email) ?? [];
  list.push(r);
  seen.set(r.email, list);
}
for (const [email, list] of seen) {
  if (list.length < 2) continue;
  for (const r of list) {
    r.create = false;
    r.reason = `duplicate email, shared with ${list.filter((o) => o !== r).map((o) => o.number).join(', ')}`;
  }
  void email;
}

// ---------------------------------------------------------------- passphrases

const willCreate = rows.filter((r) => r.create);

/**
 * The passphrases, generated HERE - in the preview - and not at apply time.
 *
 * The list somebody approves has to be the list that gets created, password
 * included. Generating them during `--apply` would mean the approved sheet and
 * the live accounts were never the same thing, and the only way to find out
 * would be an employee unable to sign in.
 *
 * So the dry run writes a plan, `--apply` is given that plan, and it creates
 * exactly what the plan says or refuses. Uniqueness is established here, over
 * the whole set, before anything is shown or written.
 */
const plan = PLAN_IN ? readPlan(PLAN_IN, willCreate) : null;

const secrets = new Map();
if (plan) {
  for (const r of willCreate) secrets.set(r.id, plan.byEmployee.get(r.id));
} else {
  const used = new Set();
  for (const r of willCreate) {
    let secret = passphrase();
    while (used.has(secret)) secret = passphrase();
    used.add(secret);
    secrets.set(r.id, secret);
  }
  if (used.size !== willCreate.length) throw new Error('Passphrase collision; aborting.');
}

// ------------------------------------------------------------------- reporting

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

console.log(`company: ${company.name}`);
console.log(`role for new accounts: ${role.name} (${role.key}, scope ${role.dataScope})`);
console.log(`passphrase: ${WORD_COUNT} words from ${WORDS.length} = ${(WORD_COUNT * BITS_PER_WORD).toFixed(0)} bits${WITH_DIGIT ? ' + a 2-digit number' : ''}`);
console.log(`mode: ${APPLY ? 'APPLY - this will write' : 'DRY RUN - nothing will be written'}\n`);

console.log('ACCOUNTS TO BE CREATED');
console.log(`${pad('Employee ID', 12)} ${pad('Employee Name', 26)} ${pad('Email', 38)} ${pad('New Account', 12)} 8-word Temporary Password`);
console.log('-'.repeat(160));
for (const r of willCreate) {
  console.log(
    `${pad(r.number, 12)} ${pad(r.name, 26)} ${pad(r.email, 38)} ${pad('YES', 12)} ${secrets.get(r.id)}`,
  );
}

console.log('\nEMPLOYEES SKIPPED - no account will be created');
console.log(`${pad('Employee ID', 12)} ${pad('Employee Name', 26)} ${pad('Email', 38)} ${pad('New Account', 12)} Reason`);
console.log('-'.repeat(160));
for (const r of rows.filter((x) => !x.create)) {
  console.log(
    `${pad(r.number, 12)} ${pad(r.name, 26)} ${pad(r.email ?? '(none)', 38)} ${pad('NO', 12)} ${r.reason ?? ''}`,
  );
}

/**
 * Mutually exclusive, so the buckets add up.
 *
 * "No usable address" covers both an employee with nothing on file and one with
 * only a personal address, because neither yields a login under the settings
 * this run was given - and a reader counting the summary against the skip list
 * should not have to work out which of two overlapping buckets somebody fell
 * into.
 */
const noEmailAtAll = rows.filter((r) => !r.email && !String(r.reason).startsWith('only a personal'));
const personalOnly = rows.filter((r) => String(r.reason).startsWith('only a personal'));
const invalidEmail = rows.filter((r) => r.email && !r.create && String(r.reason).startsWith('email '));
const duplicateEmail = rows.filter((r) => String(r.reason).startsWith('duplicate'));
const unusable = noEmailAtAll.length + personalOnly.length + invalidEmail.length;

const section = (title, list, line) => {
  console.log(`\n${title}: ${list.length}`);
  for (const r of list) console.log(`  ${pad(r.number, 12)} ${pad(r.name, 26)} ${line(r)}`);
};

section('Missing email', noEmailAtAll, () => '(no email of any kind on the profile)');
section('Personal email only', personalOnly, (r) => r.reason);
section('Invalid email', invalidEmail, (r) => `${pad(r.email, 38)} ${r.reason}`);
section('Suspicious domain - review', rows.filter((r) => r.suspect), (r) => `${pad(r.email, 38)} ${r.suspect}${r.create ? ' [creating anyway]' : ' [blocked]'}`);
section('Duplicate email', duplicateEmail, (r) => `${pad(r.email, 38)} ${r.reason}`);
section('Already has a login', rows.filter((r) => r.hasAccount), (r) => r.email ?? '');
section('Not a current employee', rows.filter((r) => String(r.reason).startsWith('not a current')), (r) => r.reason);


console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log(`  Total employees checked   ${rows.length}`);
console.log(`  Accounts to be created    ${willCreate.length}`);
console.log(`  Already existing accounts ${rows.filter((r) => r.hasAccount).length} employee(s) already linked to a login`);
console.log(`  Missing/invalid emails    ${unusable} (${noEmailAtAll.length} no email, ${personalOnly.length} personal only, ${invalidEmail.length} invalid)`);
console.log(`  Duplicate emails          ${duplicateEmail.length}`);
console.log(`  Employees skipped         ${rows.length - willCreate.length}`);
console.log('='.repeat(60));

if (!APPLY) {
  if (willCreate.length > 0 && !PLAN_IN) {
    writePlan(PLAN_OUT, willCreate, secrets);
    console.log(`\nplan written to ${PLAN_OUT} (0600) - it holds these exact passphrases.`);
  }
  console.log('\nDRY RUN - nothing was written to the database.');
  console.log('To create exactly the list above:');
  console.log(`  --apply --confirm ${CONFIRM_PHRASE} --backup <verified dump> --plan ${PLAN_IN ?? PLAN_OUT}`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------------- apply

if (value('--confirm') !== CONFIRM_PHRASE) {
  console.error(`\nRefusing to write.`);
  console.error(`--apply also requires:  --confirm ${CONFIRM_PHRASE}`);
  console.error(`Nothing was written.`);
  await prisma.$disconnect();
  process.exit(2);
}

if (!PLAN_IN) {
  console.error('\nRefusing to write.');
  console.error('--apply requires --plan <file>: the plan written by the dry run you approved.');
  console.error('Run without --apply first, read the list, then apply that plan.');
  await prisma.$disconnect();
  process.exit(2);
}

try {
  verifyBackup(BACKUP);
} catch (err) {
  // A refusal is an answer, not a crash. A stack trace here reads like the
  // script broke, when what happened is that it declined to write.
  console.error(`\nRefusing to write.`);
  console.error(err.message);
  console.error('Nothing was written.');
  await prisma.$disconnect();
  process.exit(2);
}

if (willCreate.length === 0) {
  console.log('Nothing to create.');
  await prisma.$disconnect();
  process.exit(0);
}

/**
 * Hash every approved passphrase before a single row is written.
 *
 * Each hash is verified against its own plaintext: a hash that cannot be
 * verified is an account nobody can ever sign in to, and it is far better to
 * find that here than in a support queue. Nothing is generated at this point -
 * these are the passphrases from the approved plan and no others.
 */
const credentials = [];
for (const r of willCreate) {
  const secret = secrets.get(r.id);
  if (!secret) throw new Error(`No approved passphrase for ${r.email}; aborting.`);
  const passwordHash = await hashPassword(secret);
  if (!(await verifyPassword(passwordHash, secret))) {
    throw new Error(`Hash failed to verify for ${r.email}; aborting before any write.`);
  }
  credentials.push({ ...r, secret, passwordHash });
}
if (new Set(credentials.map((c) => c.secret)).size !== credentials.length) {
  throw new Error('Approved plan contains a repeated passphrase; aborting.');
}
console.log(`${credentials.length} approved passphrases hashed and verified.\n`);

/**
 * The plaintext leaves before the database is touched.
 *
 * If the run fails half way, the operator still holds the credentials for the
 * accounts that did land. 0600, and never anywhere near the database: the only
 * thing that reaches Postgres is the Argon2id hash.
 */
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  ['employee_number,employee_name,email,temporary_password',
   ...credentials.map((c) => `${c.number},"${c.name.replace(/"/g, '""')}",${c.email},${c.secret}`)].join('\n') + '\n',
  { mode: 0o600 },
);
chmodSync(OUT, 0o600);
console.log(`credentials written to ${OUT} (0600) - distribute, then delete.\n`);

let created = 0;
for (const c of credentials) {
  await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction: the preview was a moment ago and this
    // column is unique across the whole table.
    const clash = await tx.user.findUnique({ where: { email: c.email }, select: { id: true } });
    if (clash) throw new Error(`${c.email} was taken between the preview and now; aborting.`);

    const [firstName, ...rest] = c.name.split(/\s+/);
    const user = await tx.user.create({
      data: {
        companyId: company.id,
        email: c.email,
        firstName: firstName || c.name,
        lastName: rest.join(' ') || firstName || c.name,
        passwordHash: c.passwordHash,
        // ACTIVE, because authenticate() rejects every other status and this
        // passphrase has to work. mustChangePassword is what makes it temporary.
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });

    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });

    // The account link, and nothing else on the employee row.
    await tx.employee.update({ where: { id: c.id }, data: { userId: user.id } });

    await tx.auditLog.create({
      data: {
        companyId: company.id,
        actorId: null,
        action: 'user.create',
        entityType: 'User',
        entityId: user.id,
        summary: `Bulk employee login created for ${c.email} (${c.number}) with role ${role.key}; temporary passphrase, must change on first sign-in`,
        after: { email: c.email, status: 'ACTIVE', mustChangePassword: true, roles: [role.key], employeeId: c.id },
      },
    });
  });
  created += 1;
  if (created % 10 === 0) console.log(`  ${created}/${credentials.length}`);
}

console.log(`\ncreated ${created} account(s). Credentials: ${OUT}`);
await prisma.$disconnect();
