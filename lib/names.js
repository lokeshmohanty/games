// lib/names.js — friendly random player names: "Brave Otter", "Mellow Comet".
//
// A first visit asks for a name (src/NamePrompt.tsx, Lokesh, 2026-11-21),
// pre-filled with one of these; a name nobody chose is one of these too
// (NeonArcade.defaultName, lib/net.js), never the device ("Android").
//
// An adjective and a noun (an animal, a thing from nature or the sky, a
// small object), Title Case, at most 16 characters: the party's name field
// (lib/party.js maxLength). The lists are long (memory long-play-variety) —
// about 230 × 280, some 64,000 names — and kept kind: nothing about bodies,
// minds, looks, age, faith or politics, nothing that is an insult in some
// mouth. A new word must keep `adjective + " " + noun` within 16.
//
//   NeonArcade.names.random(avoid?)  a new name, not one in `avoid` (a Set)
//   NeonArcade.names.device()        this device's own default: chosen once,
//                                    kept (localStorage "neon.defaultName")

window.NeonArcade = window.NeonArcade || {};

(() => {
	const ADJECTIVES = `
		Agile Amber Ample Arctic Astral Azure Bold Bouncy Brave Breezy Bright Brisk
		Bubbly Busy Calm Candid Cheery Chipper Civil Clever Cloudy Cobalt Comfy Cool
		Copper Cosmic Cozy Crafty Crisp Curious Dapper Daring Dashing Dawn Deft
		Dreamy Dusky Eager Early Earnest Easy Elated Electric Elfin Epic Even Fabled
		Fair Fancy Fearless Festive Fiery Flashy Fleet Floral Fluffy Flying Fond Frosty
		Funky Gentle Giddy Gilded Glad Gleaming Glossy Golden Grand Groovy Happy Hardy
		Hasty Hearty Heroic Honest Hopeful Humble Icy Jade Jaunty Jazzy Jolly Jovial
		Joyful Keen Kind Kindly Lively Loyal Lucky Lunar Lush Magic Majestic Mellow
		Merry Mighty Minty Misty Modest Mossy Nifty Nimble Noble Nordic Novel Oaken
		Ocean Olive Opal Peachy Pearly Peppy Perky Plucky Plush Polar Polite Proud
		Quick Quiet Quirky Radiant Rapid Rosy Royal Ruby Rustic Rusty Sandy Sassy
		Scarlet Serene Shiny Silent Silky Silver Sleek Sleepy Smiley Smooth Snappy
		Snowy Snug Solar Sonic Sparky Speedy Spicy Spry Starry Steady Stellar Stormy
		Sturdy Sunny Super Swift Tidy Tiny Topaz Tranquil Trusty Tulip Turbo Upbeat
		Valiant Velvet Vivid Wacky Warm Wavy Whimsy Wild Windy Winged Wise Witty
		Wooden Zany Zesty Zippy Zen Atomic Breezy Chill Dandy Dewy Fizzy Frisky Glowy
		Hazel Indigo Ivory Jumpy Lilac Lemon Maple Mint Neon Nova Orange Pastel Pixel
		Plaid Prism Quartz Retro Rocket Rugged Sage Spring Summer Autumn Winter Sugar
		Tawny Teal Thrifty Toasty Tropic Vintage Violet Wonder
	`;
	const NOUNS = `
		Otter Badger Beaver Bison Bobcat Buffalo Camel Cheetah Chipmunk Coyote Dingo
		Dolphin Donkey Elk Falcon Ferret Finch Flamingo Fox Gazelle Gecko Gibbon
		Giraffe Gopher Hamster Hare Hedgehog Heron Hippo Ibex Iguana Impala Jackal
		Jaguar Kestrel Kiwi Koala Lemur Leopard Lion Llama Lobster Lynx Magpie
		Mallard Manatee Marmot Meerkat Mink Mole Moose Narwhal Newt Ocelot Okapi
		Orca Osprey Ostrich Owl Panda Panther Parrot Pelican Penguin Pigeon Puffin
		Puma Quail Rabbit Raccoon Raven Robin Salmon Seal Shark Sloth Sparrow Squid
		Stork Swan Tapir Tiger Toucan Turtle Walrus Weasel Whale Wolf Wombat Yak
		Zebra Alpaca Axolotl Beetle Bee Bunny Butterfly Canary Cobra Crane Cricket
		Duckling Eagle Firefly Frog Goose Gull Hawk Hornet Jay Kitten Ladybug
		Lark Mantis Mongoose Moth Mustang Octopus Oriole Pony Possum Pup Robin Seahorse
		Shrimp Skunk Snail Starling Stingray Swift Tadpole Terrier Thrush Toad Trout
		Tuna Viper Vole Wren Yeti Dragon Griffin Phoenix Unicorn Kraken Sphinx Comet
		Meteor Nebula Galaxy Planet Rocket Orbit Quasar Pulsar Star Moon Sun Aurora
		Eclipse Cosmos Nova Breeze Canyon Cloud Coral Delta Desert Dune Ember Fern
		Fjord Forest Geyser Glacier Grove Harbor Island Lagoon Lake Meadow Mesa
		Monsoon Oasis Ocean Pebble Prairie Rain River Shore Sky Storm Stream Summit
		Thunder Tide Valley Volcano Wave Willow Acorn Almond Apple Banjo Biscuit
		Button Cactus Candle Cashew Cherry Cocoa Compass Cookie Crayon Cupcake Daisy
		Donut Drum Feather Fiddle Garnet Ginger Kettle Kite Lantern Lemon Lily Lotus
		Mango Maple Marble Melon Mitten Muffin Noodle Nutmeg Olive Orchid Pancake
		Papaya Peach Peanut Pepper Pickle Piano Pine Pixel Plum Poppy Pretzel Pumpkin
		Quill Radish Ribbon Saffron Sprout Teacup Thimble Tulip Turnip Waffle Walnut
		Whistle Yo-yo Zephyr Anchor Beacon Bubble Cinder Gadget Gizmo Jigsaw Marimba
		Pinwheel Rainbow Sapphire Sparkle Spindle Toffee Trumpet Tuba Ukulele Violin
	`;
	const MAX = 16;
	const words = (s) => [...new Set(s.split(/\s+/).filter(Boolean))];
	const adjectives = words(ADJECTIVES);
	const nouns = words(NOUNS);
	const pick = (list) => list[Math.floor(Math.random() * list.length)];

	/** A new name, within 16 characters, not one of `avoid` (a Set of names). */
	function random(avoid = null) {
		for (let i = 0; i < 50; i++) {
			const name = `${pick(adjectives)} ${pick(nouns)}`;
			if (name.length <= MAX && !avoid?.has(name)) return name;
		}
		return `${pick(adjectives)} ${pick(nouns)}`.slice(0, MAX);
	}

	const KEY = "neon.defaultName";
	let mine = null;
	/** This device's default name: one random name, chosen once and kept, so peers see the same one every visit. */
	function device() {
		if (mine) return mine;
		try {
			mine = localStorage.getItem(KEY);
		} catch {}
		if (!mine || mine.length > MAX) {
			mine = random();
			try {
				localStorage.setItem(KEY, mine);
			} catch {}
		}
		return mine;
	}

	NeonArcade.names = { random, device, adjectives, nouns };
})();
