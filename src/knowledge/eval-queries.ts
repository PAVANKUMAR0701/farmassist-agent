/** Labelled queries for measuring retrieval: how a farmer might describe a problem, and the note that fits. */
export const RETRIEVAL_QUERIES: Array<{ text: string; subject: 'crop' | 'animal'; expected: string }> = [
  { text: 'rice leaves have grey spots shaped like an eye', subject: 'crop', expected: 'paddy-blast' },
  { text: 'paddy ear neck turned black and the grains are empty', subject: 'crop', expected: 'paddy-blast' },
  { text: 'lots of small brown dots on paddy leaves', subject: 'crop', expected: 'paddy-brown-spot' },
  { text: 'rice leaf tips drying with yellow white stripes', subject: 'crop', expected: 'paddy-bacterial-blight' },
  { text: 'young paddy plants wilting from the leaf edges', subject: 'crop', expected: 'paddy-bacterial-blight' },
  { text: 'ragi ears turning black and the fingers are drying', subject: 'crop', expected: 'ragi-blast' },
  { text: 'finger millet leaves have grey spots', subject: 'crop', expected: 'ragi-blast' },
  { text: 'sugarcane top leaves drying and the inside of the cane is red', subject: 'crop', expected: 'sugarcane-red-rot' },
  { text: 'cane smells sour when I split it', subject: 'crop', expected: 'sugarcane-red-rot' },
  { text: 'lower leaves pale yellow and the whole field looks light green', subject: 'crop', expected: 'crop-nitrogen-deficiency' },
  { text: 'paddy central shoot has dried and comes out when pulled', subject: 'crop', expected: 'paddy-stem-borer' },
  { text: 'white empty ears in the paddy field', subject: 'crop', expected: 'paddy-stem-borer' },
  { text: 'cow is drooling a lot and limping, sores in the mouth', subject: 'animal', expected: 'cattle-fmd' },
  { text: 'blisters between the hooves of my buffalo', subject: 'animal', expected: 'cattle-fmd' },
  { text: 'cow has round lumps all over the skin', subject: 'animal', expected: 'cattle-lumpy-skin' },
  { text: 'bumps on the neck, legs swollen and fever', subject: 'animal', expected: 'cattle-lumpy-skin' },
  { text: 'udder is hard and hot and there are clots in the milk', subject: 'animal', expected: 'cattle-mastitis' },
  { text: 'blood in the milk from one teat', subject: 'animal', expected: 'cattle-mastitis' },
  { text: 'small insects stuck around the ears and udder', subject: 'animal', expected: 'cattle-ticks' },
  { text: 'cow urine is red and she has a high fever', subject: 'animal', expected: 'cattle-ticks' },
  { text: 'left side of the belly is swollen tight after eating green fodder', subject: 'animal', expected: 'cattle-bloat' },
  { text: 'stomach full of gas, not eating and restless', subject: 'animal', expected: 'cattle-bloat' },
  { text: 'cows panting with open mouth in the afternoon and milk dropped', subject: 'animal', expected: 'cattle-heat-stress' },
  { text: 'buffalo breathing fast in the hot weather', subject: 'animal', expected: 'cattle-heat-stress' },
];

/**
 * Harder set: the same problems described in different words (synonyms, Hindi/Hinglish, Tamil), avoiding the
 * notes' own vocabulary on purpose. This is where embeddings should help over keyword search.
 */
export const PARAPHRASE_QUERIES: Array<{ text: string; subject: 'crop' | 'animal'; expected: string }> = [
  { text: 'boat shaped marks with ash coloured middles on the rice crop', subject: 'crop', expected: 'paddy-blast' },
  { text: 'rice grains look dirty with dark freckles', subject: 'crop', expected: 'paddy-brown-spot' },
  { text: 'rice leaves bleached like straw from the top downwards', subject: 'crop', expected: 'paddy-bacterial-blight' },
  { text: 'millet heads went dark before the grain could fill', subject: 'crop', expected: 'ragi-blast' },
  { text: 'when I cut the cane the flesh is crimson and smells like vinegar', subject: 'crop', expected: 'sugarcane-red-rot' },
  { text: 'crop looks washed out, old leaves turning light and growth is slow', subject: 'crop', expected: 'crop-nitrogen-deficiency' },
  { text: 'middle shoot of young rice is dead and slips out easily', subject: 'crop', expected: 'paddy-stem-borer' },
  { text: 'dhan ki pattiyon par aankh jaise dhabbe', subject: 'crop', expected: 'paddy-blast' },
  { text: 'buffalo is frothing at the mouth and walking lame', subject: 'animal', expected: 'cattle-fmd' },
  { text: 'bhains ke muh se laar gir rahi hai aur khur mein chhale', subject: 'animal', expected: 'cattle-fmd' },
  { text: "my cow's hide is covered in hard round swellings like coins", subject: 'animal', expected: 'cattle-lumpy-skin' },
  { text: 'maattukku udambu muzhuvathum kattigal', subject: 'animal', expected: 'cattle-lumpy-skin' },
  { text: 'one teat gives watery milk with flakes and the quarter feels warm', subject: 'animal', expected: 'cattle-mastitis' },
  { text: 'gaay ke than mein sujan aur doodh mein khoon', subject: 'animal', expected: 'cattle-mastitis' },
  { text: 'tiny blood sucking bugs clustered inside the ears', subject: 'animal', expected: 'cattle-ticks' },
  { text: 'stomach on the left is puffed up like a balloon after grazing clover', subject: 'animal', expected: 'cattle-bloat' },
  { text: 'animals gasping and crowding in the shade at noon', subject: 'animal', expected: 'cattle-heat-stress' },
  { text: 'gaay dopahar mein haanf rahi hai aur doodh kam ho gaya', subject: 'animal', expected: 'cattle-heat-stress' },
];
