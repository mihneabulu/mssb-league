// Reference data for Mario Superstar Baseball itself — the character pool and the
// six stadiums. This is *code, not content*: it changes only when the game changes,
// it must be available to validate an upload before any season exists, and putting it
// in D1 would cost a query per request for data that ships in the bundle for free.
//
// Generated from the Season 1 teams.json + the stadium ids build.py learned from played
// games (all six confirmed). Superseded teams.json's `characters`, `characterPortraits`
// and `stadiums` keys.

/** Character names indexed by charId. */
export const CHARACTERS: readonly string[] = [
  "Mario",                  // 0
  "Luigi",                  // 1
  "DK",                     // 2
  "Diddy",                  // 3
  "Peach",                  // 4
  "Daisy",                  // 5
  "Yoshi",                  // 6
  "Baby Mario",             // 7
  "Baby Luigi",             // 8
  "Bowser",                 // 9
  "Wario",                  // 10
  "Waluigi",                // 11
  "Koopa(G)",               // 12
  "Toad(R)",                // 13
  "Boo",                    // 14
  "Toadette",               // 15
  "Shy Guy(R)",             // 16
  "Birdo",                  // 17
  "Monty",                  // 18
  "Bowser Jr",              // 19
  "Paratroopa(R)",          // 20
  "Pianta(B)",              // 21
  "Pianta(R)",              // 22
  "Pianta(Y)",              // 23
  "Noki(B)",                // 24
  "Noki(R)",                // 25
  "Noki(G)",                // 26
  "Bro(H)",                 // 27
  "Toadsworth",             // 28
  "Toad(B)",                // 29
  "Toad(Y)",                // 30
  "Toad(G)",                // 31
  "Toad(P)",                // 32
  "Magikoopa(B)",           // 33
  "Magikoopa(R)",           // 34
  "Magikoopa(G)",           // 35
  "Magikoopa(Y)",           // 36
  "King Boo",               // 37
  "Petey",                  // 38
  "Dixie",                  // 39
  "Goomba",                 // 40
  "Paragoomba",             // 41
  "Koopa(R)",               // 42
  "Paratroopa(G)",          // 43
  "Shy Guy(B)",             // 44
  "Shy Guy(Y)",             // 45
  "Shy Guy(G)",             // 46
  "Shy Guy(Bk)",            // 47
  "Dry Bones(Gy)",          // 48
  "Dry Bones(G)",           // 49
  "Dry Bones(R)",           // 50
  "Dry Bones(B)",           // 51
  "Bro(F)",                 // 52
  "Bro(B)",                 // 53
];

export const CHARACTER_COUNT = CHARACTERS.length;

/** StadiumID -> name. Every game is played at the home team's stadium. */
export const STADIUMS: Readonly<Record<number, string>> = {
  0: "Mario Stadium",
  1: "Bowser Castle",
  2: "Wario Palace",
  3: "Yoshi Park",
  4: "Peach Garden",
  5: "DK Jungle",
};

export const charName = (charId: number): string =>
  CHARACTERS[charId] ?? `#${charId}`;

export const portraitPath = (charId: number): string => `/portraits/${charId}.png`;

export const stadiumName = (stadiumId: number): string =>
  STADIUMS[stadiumId] ?? `Stadium ${stadiumId}`;

export const isValidCharId = (charId: unknown): charId is number =>
  typeof charId === 'number' && Number.isInteger(charId) && charId >= 0 && charId < CHARACTER_COUNT;

/** Stadium name -> id, used when normalizing a decoded export back to numeric ids. */
export const stadiumIdByName: ReadonlyMap<string, number> = new Map(
  Object.entries(STADIUMS).map(([id, name]) => [name, Number(id)]),
);
