/**
 * Curated reference notes for photo help (crop and cattle problems common on small Indian farms).
 * Written for FarmAssist in plain words, from widely published extension guidance; each note points to where
 * a farmer can read more. They describe what is *visible* and what is *safe to do now*: they are not a
 * diagnosis, and every note says when to call a veterinarian or agriculture officer.
 */

export interface ReferenceNote {
  id: string;
  subject: 'crop' | 'animal';
  title: string;
  /** Crops or animals it applies to. */
  appliesTo: string[];
  /** What can be seen. Used for retrieval. */
  signs: string;
  /** Safe first steps a farmer can take today. */
  firstSteps: string;
  /** When it must go to a professional. */
  escalate: string;
  /** Diseases that must be reported to the animal husbandry department. */
  notifiable?: boolean;
  /** Extra words people use (local names, symptoms) to help keyword search. */
  keywords: string[];
  readMore: string;
}

export const REFERENCE_NOTES: ReferenceNote[] = [
  {
    id: 'paddy-blast',
    subject: 'crop',
    title: 'Paddy blast (leaf and neck blast)',
    appliesTo: ['paddy', 'rice'],
    signs: 'Spindle or eye-shaped spots on leaves with grey or whitish centres and brown edges; spots can join and dry the leaf. Neck blast shows a dark ring at the base of the panicle, which breaks or stays empty.',
    firstSteps: 'Avoid extra nitrogen fertiliser for now, keep the field evenly watered, and remove badly affected straw after harvest.',
    escalate: 'If spots spread quickly or the necks turn dark at flowering, ask the agriculture officer or Krishi Vigyan Kendra which fungicide is approved and when to spray.',
    keywords: ['rice', 'leaf spot', 'eye shaped', 'diamond', 'grey centre', 'neck rot', 'empty grain', 'panicle'],
    readMore: 'TNAU Agritech Portal, rice diseases; ICAR-NRRI',
  },
  {
    id: 'paddy-brown-spot',
    subject: 'crop',
    title: 'Paddy brown spot',
    appliesTo: ['paddy', 'rice'],
    signs: 'Many small round or oval brown spots on leaves, often with a yellow halo; grains can show dark spots. Common in poor or dry soils.',
    firstSteps: 'Check soil fertility (potash and nitrogen are often low), keep water steady, and use clean, treated seed next season.',
    escalate: 'If most leaves are covered or grains are discoloured, ask the agriculture officer about a soil test and approved treatments.',
    keywords: ['rice', 'brown dots', 'small spots', 'yellow halo', 'sesame', 'poor soil'],
    readMore: 'TNAU Agritech Portal, rice diseases',
  },
  {
    id: 'paddy-bacterial-blight',
    subject: 'crop',
    title: 'Paddy bacterial leaf blight',
    appliesTo: ['paddy', 'rice'],
    signs: 'Leaves dry from the tip and edges in long yellow-to-white wavy stripes; young plants can wilt (kresek). Milky drops may ooze from cut leaves in the morning.',
    firstSteps: 'Do not over-apply nitrogen, drain and refill the field if possible, and avoid moving water from affected plots to healthy ones.',
    escalate: 'Bacterial blight cannot be cured by fungicide sprays; ask the agriculture officer for resistant varieties and management for your area.',
    keywords: ['rice', 'leaf tip drying', 'yellow stripe', 'wilting', 'kresek', 'bacteria'],
    readMore: 'ICAR-NRRI; TNAU Agritech Portal',
  },
  {
    id: 'ragi-blast',
    subject: 'crop',
    title: 'Ragi (finger millet) blast',
    appliesTo: ['ragi', 'finger millet'],
    signs: 'Eye-shaped grey spots with brown margins on leaves; at earing the neck or fingers of the ear turn black or brown and dry, and grain does not fill.',
    firstSteps: 'Remove and burn badly infected plants, avoid excess nitrogen, and keep weeds down around the field.',
    escalate: 'If the ear necks are blackening, ask the agriculture officer or KVK which treatment is approved for ragi blast.',
    keywords: ['finger millet', 'nachni', 'ear blackening', 'neck blast', 'finger blast', 'leaf spot'],
    readMore: 'ICAR-IIMR (millets); UAS Bangalore extension',
  },
  {
    id: 'sugarcane-red-rot',
    subject: 'crop',
    title: 'Sugarcane red rot',
    appliesTo: ['sugarcane'],
    signs: 'Leaves yellow and dry from the top; split canes show red inside with white cross bands and a sour, alcohol-like smell.',
    firstSteps: 'Uproot and destroy affected clumps, do not use these canes as seed, and avoid letting water flow from affected parts to others.',
    escalate: 'Red rot spreads through seed cane and water: tell the sugar factory field officer or agriculture officer and ask for a resistant variety.',
    keywords: ['cane', 'red inside', 'sour smell', 'drying top', 'rot'],
    readMore: 'ICAR-Sugarcane Breeding Institute, Coimbatore',
  },
  {
    id: 'crop-nitrogen-deficiency',
    subject: 'crop',
    title: 'Yellowing from nitrogen deficiency',
    appliesTo: ['paddy', 'rice', 'ragi', 'maize', 'sugarcane', 'any crop'],
    signs: 'Older (lower) leaves turn pale yellow first, evenly along the leaf, and the whole plant looks light green and stunted. No spots or stripes.',
    firstSteps: 'Compare with healthy patches; a leaf colour chart or soil test shows if nitrogen is low. Apply fertiliser only as recommended for the crop stage.',
    escalate: 'If yellowing comes with spots, stripes or wilting, it is likely a disease or pest instead: ask the agriculture officer.',
    keywords: ['yellow leaves', 'pale', 'light green', 'stunted', 'fertiliser', 'urea'],
    readMore: 'Soil Health Card scheme; TNAU Agritech Portal, nutrient deficiencies',
  },
  {
    id: 'paddy-stem-borer',
    subject: 'crop',
    title: 'Paddy stem borer (dead heart and white ear)',
    appliesTo: ['paddy', 'rice'],
    signs: 'The central shoot dries and pulls out easily (dead heart) in young plants; at heading, whole ears turn white and empty (white ear). Small holes may be seen on stems.',
    firstSteps: 'Pull and destroy dead hearts, collect egg masses on leaf tips, and cut the stubble low after harvest.',
    escalate: 'If many tillers are affected, ask the agriculture officer whether a treatment is needed; light traps can help monitor moths.',
    keywords: ['rice', 'dead heart', 'white ear', 'whitehead', 'empty ear', 'central shoot dry', 'borer', 'pest', 'caterpillar'],
    readMore: 'ICAR-NRRI; TNAU Agritech Portal, rice pests',
  },
  {
    id: 'cattle-fmd',
    subject: 'animal',
    title: 'Foot-and-mouth disease (FMD)',
    appliesTo: ['cow', 'buffalo', 'bull', 'calf', 'goat', 'sheep'],
    signs: 'Fever, heavy drooling with strings of saliva, blisters or raw sores on the tongue, gums and between the hooves, limping, and a sudden drop in milk.',
    firstSteps: 'Separate the animal at once, give soft feed and clean water, wash sores gently with clean water, and do not let other animals or people move between sheds.',
    escalate: 'FMD spreads very fast and must be reported: call the veterinarian or the government veterinary hospital today. Vaccinate the herd as they advise.',
    notifiable: true,
    keywords: ['foot and mouth', 'khurpaka', 'mouth sores', 'drooling', 'saliva', 'blisters', 'limping', 'hoof', 'lameness', 'milk drop'],
    readMore: 'Department of Animal Husbandry and Dairying (DAHD), National Animal Disease Control Programme',
  },
  {
    id: 'cattle-lumpy-skin',
    subject: 'animal',
    title: 'Lumpy skin disease (LSD)',
    appliesTo: ['cow', 'buffalo', 'bull', 'calf'],
    signs: 'Fever and firm, round lumps (nodules) of 1 to 5 cm on the skin, often over the neck, back and legs; swollen legs and lymph nodes, watery eyes and nose, less milk.',
    firstSteps: 'Isolate the animal, control flies and ticks around the shed, and give clean water and good feed.',
    escalate: 'Lumpy skin disease is notifiable: call the veterinarian or government veterinary hospital, who will advise on treatment and herd vaccination.',
    notifiable: true,
    keywords: ['lumpy skin', 'lumps', 'nodules', 'bumps on skin', 'swellings', 'skin disease'],
    readMore: 'DAHD advisories on lumpy skin disease',
  },
  {
    id: 'cattle-mastitis',
    subject: 'animal',
    title: 'Mastitis (udder infection)',
    appliesTo: ['cow', 'buffalo'],
    signs: 'A hot, hard, swollen or painful quarter of the udder; milk with clots, flakes, blood or a watery look; sometimes fever and less appetite.',
    firstSteps: 'Milk the affected quarter last and fully, keep the milk away from the rest, wash hands and teats, and keep the shed floor clean and dry.',
    escalate: 'Call the veterinarian soon: early treatment saves the quarter. The milk of a treated animal must be thrown away for the period the vet says.',
    keywords: ['udder', 'teat', 'swollen udder', 'clots in milk', 'blood in milk', 'hard udder', 'thanela'],
    readMore: 'NDDB animal health guides',
  },
  {
    id: 'cattle-ticks',
    subject: 'animal',
    title: 'Ticks and tick fever risk',
    appliesTo: ['cow', 'buffalo', 'bull', 'calf', 'goat', 'sheep'],
    signs: 'Small brown or grey bloodsucking parasites around the ears, neck, udder and tail; scratching, weakness or anaemia. Ticks can spread tick fever, with high fever and red or coffee-coloured urine.',
    firstSteps: 'Remove ticks by hand with gloves, clean the shed and walls, and ask about approved tick treatments for your animals.',
    escalate: 'High fever, weakness or red or dark urine needs a veterinarian the same day.',
    keywords: ['ticks', 'kilni', 'parasites', 'insects on skin', 'scratching', 'tick fever', 'red urine'],
    readMore: 'NDDB animal health guides',
  },
  {
    id: 'cattle-bloat',
    subject: 'animal',
    title: 'Bloat',
    appliesTo: ['cow', 'buffalo', 'goat', 'sheep'],
    signs: 'The left side of the belly swells high and tight like a drum, the animal stops eating, is restless, kicks at the belly or struggles to breathe; often after eating lush green fodder or legumes.',
    firstSteps: 'Stop the feed that caused it, keep the animal standing and walking slowly, and keep its front end higher than the back.',
    escalate: 'Bloat can kill within hours: call the veterinarian immediately if the belly is very tight or breathing is hard.',
    keywords: ['swollen belly', 'gas', 'tight stomach', 'left side swelling', 'afara', 'not eating'],
    readMore: 'NDDB animal health guides',
  },
  {
    id: 'cattle-heat-stress',
    subject: 'animal',
    title: 'Heat stress',
    appliesTo: ['cow', 'buffalo', 'calf'],
    signs: 'Fast, open-mouth breathing, drooling, standing in shade, less feed and a drop in milk on hot days, especially in crossbred cows.',
    firstSteps: 'Give shade and plenty of cool, clean water, splash or shower the animals in the hottest hours, and feed in the cooler morning and evening.',
    escalate: 'If the animal collapses, breathes very fast for long, or has a very high temperature, call the veterinarian.',
    keywords: ['heat', 'panting', 'hot weather', 'breathing fast', 'summer', 'milk drop'],
    readMore: 'ICAR-NDRI advisories on heat stress',
  },
];
