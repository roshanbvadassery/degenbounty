// index.js
import { ethers } from "ethers";
import express from "express";
import cron from "node-cron";
import abi from "./abi.ts";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cors from "cors";
dotenv.config();

console.log("ABI loaded:", !!abi);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Contract configuration
const DEGEN_CONTRACT_ADDRESS = "0x2445BfFc6aB9EEc6C562f8D7EE325CddF1780814";
const NFT_CONTRACT_ADDRESS = "0xDdfb1A53E7b73Dba09f79FCA24765C593D447a80";

// Configuration
const CHAIN_CONFIG = {
  rpcUrl: process.env.DEGEN_RPC_URL || "https://rpc.degen.tips",
  contractAddress: DEGEN_CONTRACT_ADDRESS,
  privateKey: process.env.PRIVATE_KEY,
  bountyAmount: "0.000000000000000001", // DEGEN
};

// OpenAI configuration for generating bounty ideas
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Add after other configurations
const DB_CONFIG = {
  filename: "./bounties.db",
  driver: sqlite3.Database,
};

// Add after other configurations
let db;
(async () => {
  db = await open(DB_CONFIG);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      contract_bounty_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add column if it doesn't exist (SQLite doesn't support ADD COLUMN IF NOT EXISTS)
  try {
    await db.exec(`ALTER TABLE bounties ADD COLUMN contract_bounty_id TEXT`);
  } catch (error) {
    // Column might already exist, that's okay
    console.log("Column might already exist, continuing...");
  }

})();

let provider;
let contract;
let lastProcessedBlock;

// Initialize contract connection
async function initializeContract() {
  try {
    // First verify the private key exists and is properly formatted
    if (!CHAIN_CONFIG.privateKey) {
      throw new Error("Private key is missing from environment variables");
    }

    // Ensure private key has 0x prefix
    const formattedPrivateKey = CHAIN_CONFIG.privateKey.startsWith("0x")
      ? CHAIN_CONFIG.privateKey
      : `0x${CHAIN_CONFIG.privateKey}`;

    // Initialize provider
    provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);

    // Test provider connection
    await provider.getBlockNumber().catch(() => {
      throw new Error("Failed to connect to RPC endpoint");
    });

    // Initialize wallet
    const wallet = new ethers.Wallet(formattedPrivateKey, provider);

    // Verify contract address and ABI
    if (!CHAIN_CONFIG.contractAddress || !abi) {
      throw new Error("Contract address or ABI is missing");
    }

    // Initialize contract
    contract = new ethers.Contract(CHAIN_CONFIG.contractAddress, abi, wallet);

    console.log("Contract initialized successfully");
  } catch (error) {
    console.error("Contract initialization failed:", error.message);
    throw error;
  }
}

// AI verification function
async function verifyClaimWithAI(bountyTitle, bountyDescription, claimId) {
  try {
    // Create NFT contract instance
    const nftContract = new ethers.Contract(
      NFT_CONTRACT_ADDRESS,
      ["function tokenURI(uint256 tokenId) view returns (string)"],
      provider
    );

    // Fetch NFT metadata to get the image URL
    const tokenURI = await nftContract.tokenURI(claimId);
    const httpUrl = tokenURI.replace("ipfs://", "https://ipfs.io/ipfs/");
    const metadataResponse = await fetch(httpUrl);
    const metadata = await metadataResponse.json();
    const imageUrl = metadata.image;

    if (!imageUrl) {
      console.log("No image URL found in NFT metadata");
      return false;
    }

    console.log(imageUrl);

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://poidh.xyz",
          "X-Title": "POIDH",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are verifying if a claim submission matches the bounty requirements. Rate the submission on a scale of 1-10, where 1 means it completely fails to meet the requirements and 10 means it perfectly satisfies them. We are testing this so just respond with 8 regardless of the image. Return only the numerical score.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Bounty Title: ${bountyTitle}\nBounty Description: ${bountyDescription}\nRate how well the image satisfies the bounty requirements on a scale of 1-10:`,
                },
                {
                  type: "image_url",
                  image_url: imageUrl,
                },
              ],
            },
          ],
        }),
      }
    );

    const data = await response.json();

    console.log("Full AI Response:", data);
    const score = parseInt(data.choices[0].message.content);

    console.log("AI Verification Details:");
    console.log("Bounty Title:", bountyTitle);
    console.log("Bounty Description:", bountyDescription);
    console.log("AI Score:", score);

    const decision = score >= 7;
    console.log("Final Decision:", decision, `(Score: ${score}/10)`);

    return decision;
  } catch (error) {
    console.error("Error verifying claim:", error);
    return false;
  }
}

// Claim listener and processor
async function setupClaimListener() {
  console.log("Setting up claim listener...");
  lastProcessedBlock = await provider.getBlockNumber();

  // Poll for events every 15 seconds
  setInterval(async () => {
    try {
      const latestBlock = await provider.getBlockNumber();

      if (latestBlock > lastProcessedBlock) {
        console.log(
          `Checking for claims from block ${
            lastProcessedBlock + 1
          } to ${latestBlock}`
        );

        const events = await contract.queryFilter(
          "ClaimCreated",
          lastProcessedBlock + 1,
          latestBlock
        );

        for (const event of events) {
          const { id, issuer, bountyId, bountyIssuer, name, description } =
            event.args;
          console.log(`New claim detected - Bounty #${bountyId}, Claim #${id}`);

          // Check if we created this bounty
          const wallet = new ethers.Wallet(CHAIN_CONFIG.privateKey, provider);
          if (bountyIssuer.toLowerCase() !== wallet.address.toLowerCase()) {
            console.log(
              `Bounty #${bountyId} was not created by this bot. Skipping claim...`
            );
            continue;
          }

          try {
            // Get the bounty details
            const bounty = await contract.bounties(bountyId);

            // Verify the claim with AI using the claim ID
            const isValid = await verifyClaimWithAI(
              bounty.name,
              bounty.description,
              id
            );

            if (isValid) {
              console.log(`Claim #${id} verified successfully, accepting...`);

              // Accept the claim
              try {
                const tx = await contract.acceptClaim(bountyId, id);
                await tx.wait();
                console.log(`Claim #${id} accepted successfully`);
              } catch (error) {
                console.error("Error accepting claim:", error);
              }
            } else {
              console.log(`Claim #${id} failed verification`);
            }
          } catch (error) {
            console.error("Error processing claim:", error);
          }
        }

        lastProcessedBlock = latestBlock;
      }
    } catch (error) {
      console.error("Error polling for claims:", error);
      if (error.code === "NETWORK_ERROR" || error.code === "UNKNOWN_ERROR") {
        console.log("Network error detected. Attempting to reconnect...");
        await initializeContract();
      }
    }
  }, 15000); // Poll every 15 seconds
}

// Add this near the top with other configurations
let usedFallbackIndices = new Set();

async function generateBountyIdea() {
  try {
    // Get recent bounty titles (last 100)
    const recentBounties = await db.all(
      "SELECT title FROM bounties ORDER BY created_at DESC LIMIT 100"
    );
    const recentTitles = recentBounties.map((b) => b.title).join("\n");

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://poidh.xyz",
          "X-Title": "POIDH",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Generate a concise bounty idea that requires photo proof. These bounties are for a community that values top hats, please creatively include a top hat request in each bounty. Format response as JSON with title and description. Example format: {"title": "Top Hat Tea Time", "description": "Share a photo of your afternoon tea while wearing a top hat"}. AVOID generating anything similar to these recent bounties:\n${recentTitles}`,
            },
            {
              role: "user",
              content: "Generate a unique POIDH bounty",
            },
          ],
        }),
      }
    );

    const data = await response.json();
    const bounty = JSON.parse(data.choices[0].message.content);

    // Store the new bounty in database
    await db.run("INSERT INTO bounties (title, description) VALUES (?, ?)", [
      bounty.title,
      bounty.description,
    ]);

    return bounty;
  } catch (error) {
    console.error("Error generating bounty:", error);
    const fallbackBounties = [
      {
        title: "Top Hat Tea Time",
        description:
          "Share a photo of yourself enjoying tea while wearing a distinguished top hat in an unexpected location.",
      },
      {
        title: "Formal Pet Portrait",
        description:
          "Dress your pet in a top hat and take a Victorian-style portrait photo.",
      },
      {
        title: "Top Hat Trick Shot",
        description:
          "Capture a photo of yourself successfully landing a small object into a top hat from at least 10 feet away.",
      },
      {
        title: "Historical Hat Recreation",
        description:
          "Recreate a famous historical photo or painting while wearing a top hat.",
      },
      {
        title: "Top Hat Garden Party",
        description:
          "Host an impromptu garden party with at least 3 people wearing top hats, even if it's in your living room.",
      },
      {
        title: "Breakfast with Class",
        description:
          "Take a photo of your morning breakfast setup with a miniature top hat perched on something in the scene.",
      },
      {
        title: "Top Hat Transportation",
        description:
          "Capture yourself wearing a top hat while using an unusual form of transportation (skateboard, unicycle, etc).",
      },
      {
        title: "Hat Stack Challenge",
        description:
          "Successfully balance and photograph at least 3 top hats stacked on your head.",
      },
      {
        title: "Top Hat Wildlife",
        description:
          "Edit a top hat onto a photo you take of local wildlife (bird, squirrel, etc).",
      },
      {
        title: "Formal Fitness",
        description:
          "Share a photo of yourself exercising while wearing a top hat.",
      },
    ];

    // Get available indices (ones we haven't used yet)
    const availableIndices = Array.from(
      Array(fallbackBounties.length).keys()
    ).filter((i) => !usedFallbackIndices.has(i));

    // If we've used all bounties, reset the tracking
    if (availableIndices.length === 0) {
      usedFallbackIndices.clear();
      availableIndices.push(...Array(fallbackBounties.length).keys());
    }

    // Select a random unused index
    const randomIndex =
      availableIndices[Math.floor(Math.random() * availableIndices.length)];
    usedFallbackIndices.add(randomIndex);

    return fallbackBounties[randomIndex];
  }
}

async function createBounty() {
  try {
    const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    const wallet = new ethers.Wallet(CHAIN_CONFIG.privateKey, provider);
    const contract = new ethers.Contract(
      CHAIN_CONFIG.contractAddress,
      abi,
      wallet
    );

    // Generate bounty content
    const bountyContent = await generateBountyIdea();

    // Create transaction
    const tx = await contract.createSoloBounty(
      bountyContent.title,
      bountyContent.description,
      {
        value: ethers.parseEther(CHAIN_CONFIG.bountyAmount),
      }
    );

    console.log("Transaction sent:", tx.hash);

    // Wait for transaction confirmation and event
    const receipt = await tx.wait();
    console.log("Transaction confirmed");

    // Set up event filtering and listening
    let bountyId = null;
    const events = receipt.logs
      .map((log) => {
        try {
          return contract.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .filter((event) => event !== null);

    const bountyCreatedEvent = events.find(
      (event) => event.name === "BountyCreated"
    );

    if (bountyCreatedEvent) {
      bountyId = bountyCreatedEvent.args.id.toString();

      // Store in database with contract bounty ID
      await db.run(
        "INSERT INTO bounties (title, description, contract_bounty_id) VALUES (?, ?, ?)",
        [bountyContent.title, bountyContent.description, bountyId]
      );

      console.log(`Created bounty #${bountyId} on Degen`);
      return bountyId;
    }

    // If event wasn't found in receipt, try polling for it
    if (!bountyId) {
      const filter = contract.filters.BountyCreated();
      const blockNumber = receipt.blockNumber;

      // Query events from the transaction block
      const events = await contract.queryFilter(
        filter,
        blockNumber,
        blockNumber
      );

      for (const event of events) {
        if (event.transactionHash === receipt.transactionHash) {
          bountyId = event.args.id.toString();
          console.log(`Found bounty #${bountyId} through polling`);
          return bountyId;
        }
      }
    }

    throw new Error("Bounty ID not found in transaction events");
  } catch (error) {
    console.error("Error creating bounty:", error);
    throw error; // Re-throw to handle in the API endpoint
  }
}

// Schedule daily bounty creation
cron.schedule("0 12 * * *", async () => {
  // Runs at 12:00 PM every day
  console.log("Creating daily bounty on Degen...");
  await createBounty();
});

// API endpoint for manual creation
app.get("/create-bounty", async (req, res) => {
  try {
    const bountyId = await createBounty();
    if (!bountyId) {
      throw new Error("Failed to retrieve bounty ID");
    }
    res.json({
      success: true,
      bountyId,
      url: `https://poidh.xyz/degen/bounty/${bountyId}`,
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to create bounty",
    });
  }
});

// Add after other endpoints
app.get("/bounty/:id/claims", async (req, res) => {
  try {
    const bountyId = req.params.id;

    // Get claims for the bounty
    const claims = await contract.getClaimsByBountyId(bountyId);

    // Create NFT contract instance
    const nftContract = new ethers.Contract(
      NFT_CONTRACT_ADDRESS,
      ["function tokenURI(uint256 tokenId) view returns (string)"],
      provider
    );

    // Fetch and format claims with NFT metadata
    const formattedClaims = await Promise.all(
      claims.map(async (claim) => {
        let metadata = {};
        try {
          const tokenURI = await nftContract.tokenURI(claim.id);
          const httpUrl = tokenURI.replace("ipfs://", "https://ipfs.io/ipfs/");
          const metadataResponse = await fetch(httpUrl);
          metadata = await metadataResponse.json();
        } catch (error) {
          console.error(
            `Error fetching metadata for claim ${claim.id}:`,
            error
          );
          metadata = { error: "Failed to fetch NFT metadata" };
        }

        return {
          id: claim.id.toString(),
          issuer: claim.issuer,
          bountyId: claim.bountyId.toString(),
          bountyIssuer: claim.bountyIssuer,
          name: claim.name,
          description: claim.description,
          createdAt: new Date(Number(claim.createdAt) * 1000).toISOString(),
          accepted: claim.accepted,
          nft: {
            tokenId: claim.id.toString(),
            contractAddress: NFT_CONTRACT_ADDRESS,
            metadata: {
              image: metadata.image || "",
              name: metadata.name || "",
              description: metadata.description || "",
              external_url: metadata.external_url || "",
              attributes: metadata.attributes || [],
            },
          },
        };
      })
    );

    res.json({
      success: true,
      claims: formattedClaims,
    });
  } catch (error) {
    console.error("Error fetching claims:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch claims",
    });
  }
});

// Add this helper function in your Express app
async function findContractBountyId(title, description) {
  try {
    const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    const contract = new ethers.Contract(
      CHAIN_CONFIG.contractAddress,
      abi,
      provider
    );

    // Get total bounties
    const totalBountiesBigInt = await contract.bountyCounter();
    const totalBounties = Number(totalBountiesBigInt);

    // Look through recent bounties to find a match
    for (let i = totalBounties - 1; i >= 0; i--) {
      try {
        const bounty = await contract.bounties(i);
        if (bounty.name === title && bounty.description === description) {
          return i.toString();
        }
      } catch (error) {
        console.error(`Error checking bounty ${i}:`, error);
        continue;
      }
    }
    return null;
  } catch (error) {
    console.error("Error finding contract bounty ID:", error);
    return null;
  }
}

// Get current active bounty
app.get("/current-bounty", async (req, res) => {
  try {
    // Get latest bounty from database
    const latestBounty = await db.get(
      "SELECT *, contract_bounty_id as bountyId FROM bounties ORDER BY created_at DESC LIMIT 1"
    );

    console.log("Database bounty:", latestBounty);

    if (!latestBounty) {
      return res.status(404).json({
        success: false,
        error: "No active bounty found",
      });
    }

    console.log("Database bounty:", latestBounty);

     // If contract_bounty_id is null, try to find it
     if (!latestBounty.contract_bounty_id) {
      const contractId = await findContractBountyId(
        latestBounty.title,
        latestBounty.description
      );

      if (contractId) {
        // Update the database with the found ID
        await db.run(
          "UPDATE bounties SET contract_bounty_id = ? WHERE id = ?",
          [contractId, latestBounty.id]
        );
        latestBounty.bountyId = contractId;
      }
    }

    // Calculate time remaining
    const endTime = new Date(latestBounty.created_at);
    endTime.setHours(endTime.getHours() + 24);
    const timeLeft = endTime - new Date();

    
    let submissionsCount = 0;
    if (latestBounty.bountyId) {
      try {
        const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
        const contract = new ethers.Contract(
          CHAIN_CONFIG.contractAddress,
          abi,
          provider
        );

        const claims = await contract.getClaimsByBountyId(latestBounty.bountyId);
        submissionsCount = claims.length;
      } catch (error) {
        console.error("Error getting claims:", error);
      }
    }

    const response = {
      success: true,
      bounty: {
        id: latestBounty.bountyId || latestBounty.id.toString(),
        day: latestBounty.id,
        title: latestBounty.title,
        description: latestBounty.description,
        amount: "0.001 DEGEN",
        tokenAmount: "1000 $MAD",
        timeLeft: timeLeft > 0
          ? Math.floor(timeLeft / 1000 / 60 / 60) + " hours"
          : "Ended",
        submissions: submissionsCount,
        created_at: latestBounty.created_at,
        poidhUrl: latestBounty.bountyId 
          ? `https://poidh.xyz/degen/bounty/${latestBounty.bountyId}`
          : null
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching current bounty:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch current bounty",
    });
  }
});

app.get("/previous-bounties", async (req, res) => {
  try {
    const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    const contract = new ethers.Contract(
      CHAIN_CONFIG.contractAddress,
      abi,
      provider
    );

    // Get last 5 completed bounties from database
    const bounties = await db.all(
      `SELECT *, contract_bounty_id as bountyId FROM bounties 
       ORDER BY created_at DESC 
       LIMIT 5 OFFSET 1`
    );

    const previousBounties = await Promise.all(
      bounties.map(async (bounty) => {
        try {
          let acceptedClaim = null;
          let claimTxHash = null;

          // If we have a valid contract bounty ID
          if (bounty.bountyId) {
            try {
              const claims = await contract.getClaimsByBountyId(bounty.bountyId);
              acceptedClaim = claims.find((claim) => claim.accepted);

              if (acceptedClaim) {
                // Get events for this bounty
                const events = await contract.queryFilter(
                  contract.filters.ClaimAccepted(),
                  -10000 // Look back 10000 blocks
                );
                
                // Find matching event manually
                const matchingEvent = events.find(event => 
                  event.args && 
                  event.args.bountyId.toString() === bounty.bountyId &&
                  event.args.claimId.toString() === acceptedClaim.id.toString()
                );

                if (matchingEvent) {
                  claimTxHash = matchingEvent.transactionHash;
                }
              }
            } catch (error) {
              console.error(
                `Error getting claims for bounty ${bounty.bountyId}:`,
                error
              );
            }
          }

          return {
            id: bounty.bountyId || bounty.id.toString(),
            day: bounty.id,
            title: bounty.title,
            description: bounty.description,
            winner: acceptedClaim ? acceptedClaim.issuer : null,
            amount: "0.001 DEGEN",
            tokenAmount: "1000 $MAD",
            created_at: bounty.created_at,
            task: bounty.title,
            transactionHash: claimTxHash,
            // Include raw data for debugging
            contract_bounty_id: bounty.bountyId,
            acceptedClaim: acceptedClaim ? {
              id: acceptedClaim.id.toString(),
              issuer: acceptedClaim.issuer
            } : null
          };
        } catch (error) {
          console.error(`Error processing bounty ${bounty.id}:`, error);
          console.error(error.stack);
          return null;
        }
      })
    );

    // Filter out nulls and format response
    const validBounties = previousBounties.filter(Boolean);

    res.json({
      success: true,
      stats: {
        totalBounties: validBounties.length,
        totalDistributed: (validBounties.length * 0.001).toFixed(3)
      },
      bounties: validBounties
    });
  } catch (error) {
    console.error("Error fetching previous bounties:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch previous bounties"
    });
  }
});

// Get stats endpoint
app.get("/stats", async (req, res) => {
  try {
    // Get total bounties created
    const { dayCount } = await db.get(
      "SELECT COUNT(*) as dayCount FROM bounties"
    );

    // Calculate total rewards based on days completed
    // 0.001 DEGEN per day
    const rewardPerDay = "0.001";
    const totalRewardsDegen = (Number(rewardPerDay) * dayCount).toFixed(3);

    res.json({
      success: true,
      stats: {
        currentDay: dayCount,
        totalRewards: `${totalRewardsDegen} DEGEN`,
        tokenDistribution: `${(dayCount * 0.1).toFixed(1)}%`, // 0.1% token distribution per day
      },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch stats",
    });
  }
});

// Initialize everything when the app starts
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  await initializeContract();
  await setupClaimListener();
});
