// Format of the output
//      Hash of the last contribution  64 Bytes
//      2^N*2-1 TauG1 Points (uncompressed)
//      2^N TauG2 Points (uncompressed)
//      2^N AlphaTauG1 Points (uncompressed)
//      2^N BetaTauG1 Points (uncompressed)

const Blake2b = require("blake2b-wasm");
const utils = require("./powersoftau_utils");
const ChaCha = require("ffjavascript").ChaCha;
const crypto = require("crypto");
const keyPair = require("./keypair");
const readline = require("readline");
const binFileUtils = require("./binfileutils");


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askEntropy() {
    return new Promise((resolve) => {
        rl.question("Enter a random text. (Entropy): ", (input) => resolve(input) );
    });
}

async function contribute(oldPtauFilename, newPTauFilename, name, entropy, verbose) {
    await Blake2b.ready();

    const {fd: fdOld, sections} = await binFileUtils.readBinFile(oldPtauFilename, "ptau", 1);
    const {curve, power, ceremonyPower} = await utils.readPTauHeader(fdOld, sections);
    if (power != ceremonyPower) {
        throw new Error("This file has been reduced. You cannot contribute into a reduced file.");
    }
    if (sections[12]) {
        console.log("WARNING: Contributing into a fle that has phase2 calculated. You will have to prepare phase2 again.");
    }
    const contributions = await utils.readContributions(fdOld, curve, sections);
    const curContribution = {
        name: name,
        type: 0, // Beacon
    };

    let lastChallangeHash;

    if (contributions.length>0) {
        lastChallangeHash = contributions[contributions.length-1].nextChallange;
    } else {
        lastChallangeHash = utils.calculateFirstChallangeHash(curve, power);
    }

    // Generate a random key
    while (!entropy) {
        entropy = await askEntropy();
    }
    const hasher = Blake2b(64);
    hasher.update(crypto.randomBytes(64));
    const enc = new TextEncoder(); // always utf-8
    hasher.update(enc.encode(entropy));
    const hash = Buffer.from(hasher.digest());

    const seed = [];
    for (let i=0;i<8;i++) {
        seed[i] = hash.readUInt32BE(i*4);
    }
    const rng = new ChaCha(seed);
    curContribution.key = keyPair.createPTauKey(curve, lastChallangeHash, rng);


    const newChallangeHasher = new Blake2b(64);
    newChallangeHasher.update(lastChallangeHash);

    const responseHasher = new Blake2b(64);
    responseHasher.update(lastChallangeHash);

    const fdNew = await binFileUtils.createBinFile(newPTauFilename, "ptau", 1, 7);
    await utils.writePTauHeader(fdNew, curve, power);

    let firstPoints;
    firstPoints = await processSection(2, "G1",  (1<<power) * 2 -1, curve.Fr.e(1), curContribution.key.tau.prvKey, "tauG1" );
    curContribution.tauG1 = firstPoints[1];
    firstPoints = await processSection(3, "G2",  (1<<power) , curve.Fr.e(1), curContribution.key.tau.prvKey, "tauG2" );
    curContribution.tauG2 = firstPoints[1];
    firstPoints = await processSection(4, "G1",  (1<<power) , curContribution.key.alpha.prvKey, curContribution.key.tau.prvKey, "alphaTauG1" );
    curContribution.alphaG1 = firstPoints[0];
    firstPoints = await processSection(5, "G1",  (1<<power) , curContribution.key.beta.prvKey, curContribution.key.tau.prvKey, "betaTauG1" );
    curContribution.betaG1 = firstPoints[0];
    firstPoints = await processSection(6, "G2",  1, curContribution.key.beta.prvKey, curContribution.key.tau.prvKey, "betaTauG2" );
    curContribution.betaG2 = firstPoints[0];

    curContribution.nextChallange = newChallangeHasher.digest();

    console.log("Next Challange Hash: ");
    console.log(utils.formatHash(curContribution.nextChallange));

    curContribution.partialHash = responseHasher.getPartialHash();

    const buffKey = new Uint8Array(curve.F1.n8*2*6+curve.F2.n8*2*3);

    utils.toPtauPubKeyRpr(buffKey, 0, curve, curContribution.key, false);

    responseHasher.update(new Uint8Array(buffKey));
    const hashResponse = responseHasher.digest();

    console.log("Contribution Response Hash imported: ");
    console.log(utils.formatHash(hashResponse));

    contributions.push(curContribution);

    await utils.writeContributions(fdNew, curve, contributions);

    await fdOld.close();
    await fdNew.close();

    return;
    async function processSection(sectionId, groupName, NPoints, first, inc, sectionName) {
        const res = [];
        fdOld.pos = sections[sectionId][0].p;
        await fdNew.writeULE32(sectionId); // tauG1
        const pSection = fdNew.pos;
        await fdNew.writeULE64(0); // Temporally set to 0 length

        const G = curve[groupName];
        const sG = G.F.n8*2;
        const chunkSize = Math.floor((1<<20) / sG);   // 128Mb chunks
        let t = first;
        for (let i=0 ; i<NPoints ; i+= chunkSize) {
            if ((verbose)&&i) console.log(`${sectionName}: ` + i);
            const n= Math.min(NPoints-i, chunkSize );
            const buffIn = await fdOld.read(n * sG);
            const buffOutLEM = await G.batchApplyKey(buffIn, t, inc);
            const promiseWrite = fdNew.write(buffOutLEM);
            const buffOutU = await G.batchLEMtoU(buffOutLEM);
            const buffOutC = await G.batchLEMtoC(buffOutLEM);

            newChallangeHasher.update(buffOutU);
            responseHasher.update(buffOutC);
            await promiseWrite;
            if (i==0)   // Return the 2 first points.
                for (let j=0; j<Math.min(2, NPoints); j++)
                    res.push(G.fromRprLEM(buffOutLEM, j*sG));
            t = curve.Fr.mul(t, curve.Fr.pow(inc, n));
        }

        const sSize  = fdNew.pos - pSection -8;
        const lastPos = fdNew.pos;
        await fdNew.writeULE64(sSize, pSection);
        fdNew.pos = lastPos;
        return res;
    }

}

module.exports = contribute;
