import { randomInt } from 'node:crypto';

/**
 * Temporary passphrases for an administrator to read out loud.
 *
 * This exists because a password an administrator hands over in person has a
 * different job from one a person chooses: it has to survive being dictated
 * over a phone, typed by somebody who has never seen it, and then thrown away.
 * Four common words and a two-digit number do that; `Xk9$mQ2!vL` does not, and
 * the person on the other end writes it down wrong.
 *
 * The vocabulary is the one `scripts/create-employee-logins.mjs` used for the
 * passphrases already distributed, so what this hands out looks like what the
 * workforce has already been given. That script keeps its own copy: it ran
 * once, against a database that no longer needs it, and rewriting a tool whose
 * output is already in people's hands to import from the application it predates
 * would be churn with a blast radius and no benefit.
 *
 * Strength: 2451 words at 11.26 bits each, so four words carry about 45 bits
 * before the digits. That is not the account's security - the passphrase is
 * dead the moment it is used, because `user.password.set` writes
 * `mustChangePassword` alongside it - it is enough that guessing one inside its
 * short life is not worth attempting.
 */
const WORDS = [
  `able acid acorn actor adapt add adobe adopt adult aflame afraid again agent agile agree ahead`,
  `aid aim air alarm album alert alien alike alive alley allow almond aloe alone along aloud`,
  `alpha also alter amber amble amend amid ample amuse anchor angel anger angle animal ankle`,
  `annual answer ant anthem anvil anyone apart apex apple april apron arcade arch arctic area`,
  `arena argue arise arm armor army aroma arrow art ashen aside ask aspen asset atlas atom attic`,
  `auburn audio audit august aunt author auto autumn avenue avoid awake award aware away awning`,
  `axis baby back bacon badge bagel baker balance balcony bald ballad balloon bamboo banana band`,
  `banjo bank banner barn barrel base basil basin basket bass batch bath baton bay beach beacon`,
  `bead beam bean bear beat beaver bed beech beef beetle begin behave behind being belfry bell`,
  `belong belt bench bend berry beside best beta better beyond bicycle bid big bike bill binary`,
  `birch bird birth biscuit bishop bison bit bitter black blade blanket blast blaze blend bless`,
  `blind blink block bloom blossom blue blush board boat body boil bold bolt bonnet bonus book`,
  `boost boot border born borrow bother bottle bottom boulder bounce bound bow bowl box boy brace`,
  `braid brain brake branch brand brass brave bread break breeze brick bridge brief bright bring`,
  `brisk broad broil broken bronze brook broom brother brown brush bubble bucket buckle bud`,
  `budget buffet bugle build bulb bulk bull bundle bunk burden burn burst bus bush business busy`,
  `butter button buy buzz cabin cable cactus cadet cage cake calm camel camera camp canal candle`,
  `candy cane canoe canvas canyon cap cape captain car carbon card care cargo carpet carrot cart`,
  `carve case cash cask cast castle cat catch cattle cause cave cedar ceiling cell cement census`,
  `cent center ceramic cereal chain chair chalk champ chance change channel chant chapel charm`,
  `chart chase cheap check cheer cheese chef cherry chess chest chew chief child chill chimney`,
  `chin chip chirp chisel choice choose chop chorus chosen chrome chunk church cider cigar cinema`,
  `circle circus citizen city civic civil claim clam clap clarity clash class clay clean clear`,
  `clerk clever cliff climb cling clinic clip cloak clock close cloth cloud clover club clump`,
  `cluster clutch coach coal coast coat cobalt cocoa code coffee coil coin cold collar colony`,
  `color colt column comb combine come comet comfort comic common compact compass compete concert`,
  `concrete condor cone confirm connect consent console constant contact contest control convert`,
  `cook cool copper copy coral cord core cork corn corner correct corridor cost cottage cotton`,
  `couch cough count county couple courage course court cousin cover cow crab crack cradle craft`,
  `crane crash crate crawl crayon cream create credit creek crest crew cricket crimson crisp`,
  `critic crop cross crowd crown crumb crush crust cry crystal cube cuckoo cue cuff culture cup`,
  `curb cure curious curl current curtain curve cushion custom cut cycle cypress dagger daily`,
  `dairy daisy dam damp dance danger dare dark dart dash data date dawn day deal dear debate`,
  `debris decade decide deck decor deep deer defend define degree delay delta demand denim dense`,
  `dental deny depart depend deposit depth derby desert design desk detail detect device devote`,
  `dial diamond diary dice diesel diet differ dig digital dignity dim dine dinner direct dirt`,
  `disc dish disk dismiss display distance ditch dive divide dock doctor dodge dog dollar dolphin`,
  `dome donate donkey door dose dot double dough dove down dozen draft drag dragon drain drama`,
  `draw dream dress drift drill drink drive drop drum dry duck duel duet dull dune dusk dust duty`,
  `dwarf dwell dye dynamo eager eagle ear early earn earth ease east easy eat echo eclipse edge`,
  `edit effort egg eight elbow elder elect electric elegant element elephant eleven elite elm`,
  `embark ember emblem embrace emerald emerge emit empire employ empty enable enact enamel`,
  `enchant end endure enemy energy engage engine enjoy enlist enough enrich ensure enter entire`,
  `entry envelope equal equip era erase errand error escape essay estate etch eternal ethics`,
  `evening event ever every evidence exact exam example exceed excite exhale exist exit expand`,
  `expect expert explain export express extend extra eye fabric face fact factor fade fair fairy`,
  `faith falcon fall false fame family famous fan fancy far farm fashion fast fasten fatal father`,
  `fault favor fawn fear feast feather fee feed feel fellow felt fence fern ferry fetch fever few`,
  `fiber fiction field fierce fifteen fifty fig fight figure file fill film filter final finch`,
  `find fine finger finish fir fire firm first fish fist fit five fix flag flame flare flash flat`,
  `flavor flax fleet flesh flex flight flint flip float flock flood floor flour flow flower fluid`,
  `flute fly foam focus fog foil fold folk follow fond food fool foot force forest forever forge`,
  `fork form fort forty forum forward fossil foster found four fox frame free freeze fresh friend`,
  `fringe frog from front frost frown frozen fruit fuel full fun fund funny fur furnace future`,
  `gadget gain galaxy gallery gallon game gap garage garden garlic garment gas gate gather gauge`,
  `gaze gear gem general gentle genuine gesture ghost giant gift ginger giraffe girl give glacier`,
  `glad glance glass glaze gleam glide glimpse globe gloom glory glove glow glue goal goat gold`,
  `golf good goose gorge gown grab grace grade grain grand granite grant grape graph grasp grass`,
  `grave gravel gray great green greet grid grief grill grin grip grit grocery groom groove`,
  `ground group grove grow guard guess guest guide guild guitar gulf gull gum gust gym habit hail`,
  `hair half hall halt hammer hamster hand handle hang happy harbor hard hare harm harp harvest`,
  `hat hatch hawk hazel head heal health heap hear heart heat heavy hedge heel height helm help`,
  `hen herb herd here hero hidden hide high hill hint hip hire history hive hobby hockey hold`,
  `hole hollow holy home honest honey hood hoof hook hope horizon horn horse hose host hotel hour`,
  `house hover howl hub huge human humble humid humor hundred hunger hunt hurdle hurry hurt husk`,
  `hut hybrid hymn ice icon idea ideal idle igloo ill image impact imply import impose impulse`,
  `inch include income indeed index indoor infant inform inherit initial ink inlet inner input`,
  `insect inside insist inspect install instant intact intend invest invite iris iron island`,
  `issue item ivory ivy jacket jade jaguar jam jar jaw jazz jeans jelly jet jewel job jog join`,
  `joint joke jolly journal journey joy judge juice july jump june jungle junior jury just kayak`,
  `keen keep kennel kernel kettle key kick kid kidney kind king kiss kit kitchen kite kitten knee`,
  `kneel knife knight knit knob knock knot know lab label labor lace ladder lady lake lamb lamp`,
  `land lane language lantern lap large laser last latch late later laugh launch laundry lava law`,
  `lawn layer lazy lead leaf league lean leap learn lease leash least leather leave lecture ledge`,
  `left leg legacy legal legend lemon lend length lens leopard lesson let letter level liberty`,
  `library license lid life lift light like lilac lily limb lime limit line linen link lion lip`,
  `liquid list listen liter little live lizard load loaf loan lobby local lock lodge loft log`,
  `logic lonely long look loop loose lord lose loss lost lot loud lounge love low loyal luck`,
  `lumber lunar lunch lung luxury lyric machine mad magic magnet maid mail main major make mammal`,
  `man manage mango manor mantle manual maple marble march margin marine mark market marsh mask`,
  `mason mast master match mate math matrix matter mature maze meadow meal mean measure meat`,
  `medal media medium meet melody melon melt member memory mend mention menu mercy merge merit`,
  `merry mesh message metal meteor method middle midnight might mild mile milk mill mind mine`,
  `mineral mingle mint minute mirror miss mist mix mobile model modern modest moist mold moment`,
  `monarch money monitor monkey month moon moral more morning mortal mosaic moss most motel moth`,
  `mother motion motor mount mouse mouth move movie much mud muffin mule multiply muscle museum`,
  `music must mustard mutual myself mystery nail name napkin narrow nation native nature navy`,
  `near neat neck need needle neighbor neon nerve nest net network neutral never new news next`,
  `nice niche nickel night nine noble nod noise noon normal north nose note notice novel november`,
  `now nozzle number nurse nut oak oar oasis oat obey object oblige observe obtain occupy occur`,
  `ocean october odd odor offer office often oil olive omega once onion online only onto open`,
  `opera opinion oppose option orange orbit orchard order organ origin ornate orphan ostrich`,
  `other otter ounce out oval oven over owl own oxygen oyster pace pack pad page paint pair`,
  `palace pale palm pan panda panel panic pants paper parade parcel pardon parent park parrot`,
  `parsley part party pass past pasta pastel patch path patient patrol pattern pause pave paw pay`,
  `peace peach peak peanut pear pearl pebble pecan pedal peel peer pelican pen pencil penguin`,
  `people pepper perch perfect perform perhaps period permit person pest petal phase phone photo`,
  `phrase piano pick picnic picture pie piece pier pigeon pile pilgrim pillar pillow pilot pin`,
  `pinch pine pink pint pioneer pipe pistol pit pitch pity pixel pizza place plain plan planet`,
  `plank plant plaster plastic plate play plaza pleasant please pledge plenty plot plow plug plum`,
  `plunge plus pocket poem poet point polar pole police polish polite pond pony pool poplar poppy`,
  `popular porch pork port portion pose position possible post pot potato pottery pouch pound`,
  `pour powder power praise prank prawn pray precise prefer premium prepare present press pretty`,
  `prevent price pride prime print prior prism prison private prize problem proceed produce`,
  `profile program project promise proof proper protect proud prove provide public pudding puff`,
  `pull pulse pump punch pupil puppy pure purple purpose purse push put puzzle pyramid quail`,
  `quaint quality quarry quarter queen query quest question queue quick quiet quilt quit quiz`,
  `quota quote rabbit raccoon race rack radar radio radish raft rag rail rain raise rake rally`,
  `ramp ranch random range rank rapid rare rate rather ratio raven raw ray reach read ready real`,
  `reason rebel recall receive recent recipe record recover red reduce reed reef refer reflect`,
  `refuge refuse regard region regret regular reject rejoice relax relay release relief rely`,
  `remain remark remedy remind remote remove render renew rent repair repeat reply report request`,
  `require rescue research reserve resist resolve resort respect respond rest result retail`,
  `retire return reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid`,
  `rim ring rinse ripe ripple rise risk ritual rival river road roam roar roast robe robin robot`,
  `rock rocket rod rogue role roll roof room root rope rose rotate rough round route routine row`,
  `royal rubber ruby rug rule ruler rumor run runner rural rush rust sack sacred sad saddle safe`,
  `sage sail saint salad salmon salon salt salute same sample sand sandal sauce sausage save saw`,
  `say scale scan scar scarf scatter scene scent school science scissors scoop scope score scout`,
  `scrap screen script scroll sculpt sea seal search season seat second secret section secure`,
  `seed seek seem segment select self sell senate send senior sense sentence series serious serve`,
  `session settle seven sever shade shadow shaft shake shallow shame shape share shark sharp shed`,
  `sheep sheet shelf shell shelter shield shift shine ship shirt shiver shock shoe shoot shop`,
  `shore short should shoulder shout shovel show shower shrimp shrub shuffle shut shy sibling`,
  `side siege sigh sight sign signal silent silk silly silver similar simple since sing single`,
  `sink sir sister sit site six size skate sketch ski skill skin skip skirt skull sky slab slam`,
  `sleep sleeve slender slice slide slight slim slip slogan slope slot slow small smart smell`,
  `smile smoke smooth snack snail snake snap sneak snow soap soccer social sock soda soft soil`,
  `solar soldier solid solve some son song soon sorry sort soul sound soup source south space`,
  `spare spark speak special speech speed spell spend sphere spice spider spike spill spin spirit`,
  `split spoke sponge spoon sport spot spray spread spring sprout spruce spur spy square squash`,
  `squeeze squid stable stack staff stage stairs stamp stand star start state station statue stay`,
  `steady steak steam steel steep steer stem step stick stiff still sting stir stock stone stool`,
  `stop store storm story stove straight strain strand strap straw stream street stress stretch`,
  `strike string strip stroke strong studio study stuff style subject submit subway succeed such`,
  `sudden suffer sugar suggest suit summer summit sun sunny sunset super supply support suppose`,
  `supreme sure surf surface surge surprise survey survive suspect sustain swallow swan swap`,
  `swarm sweat sweep sweet swell swift swim swing switch sword symbol syrup system table tackle`,
  `tag tail tailor take tale talent talk tall tandem tank tape target task taste tattoo tax taxi`,
  `tea teach team tear tease tech teeth tell temple ten tenant tend tennis tense tent term test`,
  `text than thank that theme theory there thick thief thin thing think third thirty this thorn`,
  `those thread three thrive throat throne through throw thumb thunder ticket tide tidy tie tiger`,
  `tight tile till timber time tin tiny tip tire title toast today toe together toilet token toll`,
  `tomato tone tongs tonight tool tooth top topic torch total touch tough tour toward towel tower`,
  `town toy trace track trade traffic trail train trait tram trap travel tray treat tree trend`,
  `trial tribe trick trim trip triumph trolley troop trophy trouble truck true trumpet trunk`,
  `trust truth try tube tuck tulip tumble tuna tune tunnel turkey turn turtle twelve twenty twice`,
  `twig twin twist two type ugly umbrella uncle under undo unfold unify union unique unit unite`,
  `universe unlock until unusual upon upper upset urban urge usage use useful usual utility`,
  `vacant vacuum vague valid valley value valve van vanilla vapor variety vase vast vault vector`,
  `velvet vendor venture venue verb verdict verse version vessel veteran vibrant victory video`,
  `view village vine vinyl violet violin virtue visa visible vision visit vital vivid vocal voice`,
  `void volcano volume vote voyage wade wafer wage wagon waist wait wake walk wall walnut wander`,
  `want war wardrobe warm warn warrant wash wasp waste watch water wave wax way weak wealth`,
  `weapon wear weather weave web wedge week weigh weird welcome weld well west wet whale wheat`,
  `wheel when where which while whisper whistle white whole why wide widow width wild will willow`,
  `win wind window wine wing wink winter wipe wire wisdom wise wish wit witness wizard wolf woman`,
  `wonder wood wool word work world worm worry worth wound woven wrap wreath wrench wrist write`,
  `wrong yard yarn yawn year yeast yellow yes yet yield yoga yogurt yolk you young zebra zenith`,
  `zero zest zigzag zinc zone zoo`,
]
  .join(' ')
  .split(/\s+/)
  .filter(Boolean);

/** Words per passphrase. Four is the most a person reliably reads back. */
const WORD_COUNT = 4;

/**
 * One passphrase: four words and a two-digit number, hyphen separated.
 *
 * `randomInt` is the CSPRNG rather than `Math.random`, and the trailing number
 * is not decoration - `passwordSchema` requires a digit, so a passphrase
 * without one could not be set through the same validation everything else
 * goes through.
 */
export function generatePassphrase(): string {
  const picked: string[] = [];
  for (let i = 0; i < WORD_COUNT; i += 1) picked.push(WORDS[randomInt(WORDS.length)] as string);
  return `${picked.join('-')}-${String(randomInt(10, 100))}`;
}
