// index.js
import { ethers } from 'ethers';
import express from 'express';
import cron from 'node-cron';
import abi from './abi.js';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Contract configuration
const DEGEN_CONTRACT_ADDRESS = "0x2445BfFc6aB9EEc6C562f8D7EE325CddF1780814";
const NFT_CONTRACT_ADDRESS = "0xDdfb1A53E7b73Dba09f79FCA24765C593D447a80";

// Configuration
const CHAIN_CONFIG = {
  rpcUrl: process.env.DEGEN_RPC_URL || "https://rpc.degen.tips",
  contractAddress: DEGEN_CONTRACT_ADDRESS,
  privateKey: process.env.PRIVATE_KEY,
  bountyAmount: "0.000000000000000001" // DEGEN
};

// OpenAI configuration for generating bounty ideas
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Add after other configurations
const DB_CONFIG = {
  filename: './bounties.db',
  driver: sqlite3.Database
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

let provider;
let contract;
let lastProcessedBlock;

// Initialize contract connection
async function initializeContract() {
  provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
  const wallet = new ethers.Wallet(CHAIN_CONFIG.privateKey, provider);
  contract = new ethers.Contract(CHAIN_CONFIG.contractAddress, abi, wallet);
}

// AI verification function
async function verifyClaimWithAI(bountyTitle, bountyDescription, claimId) {
  try {
    // Create NFT contract instance
    const nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, [
      'function tokenURI(uint256 tokenId) view returns (string)'
    ], provider);

    // Fetch NFT metadata to get the image URL
    const tokenURI = await nftContract.tokenURI(claimId);
    const httpUrl = tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const metadataResponse = await fetch(httpUrl);
    const metadata = await metadataResponse.json();
    const imageUrl = metadata.image;

    if (!imageUrl) {
      console.log('No image URL found in NFT metadata');
      return false;
    }

    console.log(imageUrl);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://poidh.xyz',
        'X-Title': 'POIDH',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are verifying if a claim submission matches the bounty requirements. Rate the submission on a scale of 1-10, where 1 means it completely fails to meet the requirements and 10 means it perfectly satisfies them. We are testing this so just respond with 8 regardless of the image. Return only the numerical score.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Bounty Title: ${bountyTitle}\nBounty Description: ${bountyDescription}\nRate how well the image satisfies the bounty requirements on a scale of 1-10:`
              },
              {
                type: 'image_url',
                image_url: imageUrl
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    console.log('Full AI Response:', data);
    const score = parseInt(data.choices[0].message.content);
    
    console.log('AI Verification Details:');
    console.log('Bounty Title:', bountyTitle);
    console.log('Bounty Description:', bountyDescription);
    console.log('AI Score:', score);
    
    const decision = score >= 7;
    console.log('Final Decision:', decision, `(Score: ${score}/10)`);
    
    return decision;
  } catch (error) {
    console.error('Error verifying claim:', error);
    return false;
  }
}

// Claim listener and processor
async function setupClaimListener() {
  console.log('Setting up claim listener...');
  lastProcessedBlock = await provider.getBlockNumber();
  
  // Poll for events every 15 seconds
  setInterval(async () => {
    try {
      const latestBlock = await provider.getBlockNumber();
      
      if (latestBlock > lastProcessedBlock) {
        console.log(`Checking for claims from block ${lastProcessedBlock + 1} to ${latestBlock}`);
        
        const events = await contract.queryFilter('ClaimCreated', lastProcessedBlock + 1, latestBlock);
        
        for (const event of events) {
          const { id, issuer, bountyId, bountyIssuer, name, description } = event.args;
          console.log(`New claim detected - Bounty #${bountyId}, Claim #${id}`);
          
          // Check if we created this bounty
          const wallet = new ethers.Wallet(CHAIN_CONFIG.privateKey, provider);
          if (bountyIssuer.toLowerCase() !== wallet.address.toLowerCase()) {
            console.log(`Bounty #${bountyId} was not created by this bot. Skipping claim...`);
            continue;
          }
          
          try {
            // Get the bounty details
            const bounty = await contract.bounties(bountyId);
            
            // Verify the claim with AI using the claim ID
            const isValid = await verifyClaimWithAI(bounty.name, bounty.description, id);
            
            if (isValid) {
              console.log(`Claim #${id} verified successfully, accepting...`);
              
              // Accept the claim
              try {
                const tx = await contract.acceptClaim(bountyId, id);
                await tx.wait();
                console.log(`Claim #${id} accepted successfully`);
              } catch (error) {
                console.error('Error accepting claim:', error);
              }
            } else {
              console.log(`Claim #${id} failed verification`);
            }
          } catch (error) {
            console.error('Error processing claim:', error);
          }
        }
        
        lastProcessedBlock = latestBlock;
      }
    } catch (error) {
      console.error('Error polling for claims:', error);
      if (error.code === 'NETWORK_ERROR' || error.code === 'UNKNOWN_ERROR') {
        console.log('Network error detected. Attempting to reconnect...');
        await initializeContract();
      }
    }
  }, 15000); // Poll every 15 seconds
}

async function generateBountyIdea() {
  try {
    // Get recent bounty titles (last 100)
    const recentBounties = await db.all(
      'SELECT title FROM bounties ORDER BY created_at DESC LIMIT 100'
    );
    const recentTitles = recentBounties.map(b => b.title).join('\n');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://poidh.xyz',
        'X-Title': 'POIDH',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Generate a concise bounty idea that requires photo proof. Format response as JSON with title and description. 
            AVOID generating anything similar to these recent bounties:\n${recentTitles}`
          },
          {
            role: 'user',
            content: 'Generate a unique POIDH bounty'
          }
        ]
      })
    });

    const data = await response.json();
    const bounty = JSON.parse(data.choices[0].message.content);
    
    // Store the new bounty in database
    await db.run(
      'INSERT INTO bounties (title, description) VALUES (?, ?)',
      [bounty.title, bounty.description]
    );

    return bounty;
  } catch (error) {
    console.error('Error generating bounty:', error);
    return {
      title: "Daily Challenge",
      description: "Take a creative photo of your breakfast and share it with the community."
    };
  }
}

async function createBounty() {
  try {
    const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    const wallet = new ethers.Wallet(CHAIN_CONFIG.privateKey, provider);
    const contract = new ethers.Contract(CHAIN_CONFIG.contractAddress, abi, wallet);

    // Generate bounty content
    const bountyContent = await generateBountyIdea();

    // Create transaction
    const tx = await contract.createSoloBounty(
      bountyContent.title,
      bountyContent.description,
      {
        value: ethers.parseEther(CHAIN_CONFIG.bountyAmount)
      }
    );

    console.log('Transaction sent:', tx.hash);

    // Wait for transaction confirmation and event
    const receipt = await tx.wait();
    console.log('Transaction confirmed');

    // Set up event filtering and listening
    let bountyId = null;
    const events = receipt.logs.map(log => {
      try {
        return contract.interface.parseLog(log);
      } catch (e) {
        return null;
      }
    }).filter(event => event !== null);

    const bountyCreatedEvent = events.find(event => event.name === "BountyCreated");

    if (bountyCreatedEvent) {
      bountyId = bountyCreatedEvent.args.id.toString();
      console.log(`Created bounty #${bountyId} on Degen`);
      return bountyId;
    }

    // If event wasn't found in receipt, try polling for it
    if (!bountyId) {
      const filter = contract.filters.BountyCreated();
      const blockNumber = receipt.blockNumber;
      
      // Query events from the transaction block
      const events = await contract.queryFilter(filter, blockNumber, blockNumber);
      
      for (const event of events) {
        if (event.transactionHash === receipt.transactionHash) {
          bountyId = event.args.id.toString();
          console.log(`Found bounty #${bountyId} through polling`);
          return bountyId;
        }
      }
    }

    throw new Error('Bounty ID not found in transaction events');

  } catch (error) {
    console.error('Error creating bounty:', error);
    throw error; // Re-throw to handle in the API endpoint
  }
}

// Schedule daily bounty creation
cron.schedule('0 12 * * *', async () => { // Runs at 12:00 PM every day
  console.log('Creating daily bounty on Degen...');
  await createBounty();
});

// API endpoint for manual creation
app.get('/create-bounty', async (req, res) => {
  try {
    const bountyId = await createBounty();
    if (!bountyId) {
      throw new Error('Failed to retrieve bounty ID');
    }
    res.json({ 
      success: true, 
      bountyId,
      url: `https://poidh.xyz/degen/bounty/${bountyId}`
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to create bounty' 
    });
  }
});

// Add after other endpoints
app.get('/bounty/:id/claims', async (req, res) => {
  try {
    const bountyId = req.params.id;
    
    // Get claims for the bounty
    const claims = await contract.getClaimsByBountyId(bountyId);
    
    // Create NFT contract instance
    const nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, [
      'function tokenURI(uint256 tokenId) view returns (string)'
    ], provider);
    
    // Fetch and format claims with NFT metadata
    const formattedClaims = await Promise.all(claims.map(async claim => {
      let metadata = {};
      try {
        const tokenURI = await nftContract.tokenURI(claim.id);
        const httpUrl = tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/');
        const metadataResponse = await fetch(httpUrl);
        metadata = await metadataResponse.json();
      } catch (error) {
        console.error(`Error fetching metadata for claim ${claim.id}:`, error);
        metadata = { error: 'Failed to fetch NFT metadata' };
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
            image: metadata.image || '',
            name: metadata.name || '',
            description: metadata.description || '',
            external_url: metadata.external_url || '',
            attributes: metadata.attributes || []
          }
        }
      };
    }));

    res.json({ 
      success: true, 
      claims: formattedClaims
    });
  } catch (error) {
    console.error('Error fetching claims:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch claims'
    });
  }
});

// Initialize everything when the app starts
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  await initializeContract();
  await setupClaimListener();
});