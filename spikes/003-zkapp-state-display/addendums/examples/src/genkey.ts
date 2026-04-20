import { PrivateKey } from "o1js";

const priv = PrivateKey.random();
console.log("privateKey:", priv.toBase58());
console.log("publicKey: ", priv.toPublicKey().toBase58());
