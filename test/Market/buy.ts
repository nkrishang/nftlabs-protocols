import { ethers } from "hardhat";
import chai, { expect } from "chai";
import { solidity } from "ethereum-waffle";
chai.use(solidity);

// Contract Types
import { AccessNFT } from "../../typechain/AccessNFT";
import { Market } from "../../typechain/Market";
import { Coin } from "../../typechain/Coin";
import { Forwarder } from "../../typechain/Forwarder";
import { ProtocolControl } from "../../typechain/ProtocolControl";

// Types
import { BigNumber } from "ethers";
import { BytesLike } from "@ethersproject/bytes";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

// Test utils
import { getContracts, Contracts } from "../../utils/tests/getContracts";
import { getURIs, getAmounts, getBoundedEtherAmount, getAmountBounded } from "../../utils/tests/params";
import { forkFrom } from "../../utils/tests/hardhatFork";
import { sendGaslessTx } from "../../utils/tests/gasless";
import { Registry } from "../../typechain/Registry";

describe("List token for sale", function () {
  // Signers
  let protocolProvider: SignerWithAddress;
  let protocolAdmin: SignerWithAddress;
  let creator: SignerWithAddress;
  let buyer: SignerWithAddress;
  let relayer: SignerWithAddress;

  // Contracts
  let registry: Registry;
  let market: Market;
  let accessNft: AccessNFT;
  let coin: Coin;
  let protocolControl: ProtocolControl;
  let forwarder: Forwarder;

  // Reward parameters
  const rewardURIs: string[] = getURIs();
  const accessURIs = getURIs(rewardURIs.length);
  const rewardSupplies: number[] = getAmounts(rewardURIs.length);
  const emptyData: BytesLike = ethers.utils.toUtf8Bytes("");

  // Token IDs
  let rewardId: number = 1;

  // Market params: list
  const price: BigNumber = getBoundedEtherAmount();
  const amountOfTokenToList = getAmountBounded(rewardSupplies[0]);
  const tokensPerBuyer = getAmountBounded(parseInt(amountOfTokenToList.toString()));
  const secondsUntilStart: number = 0;
  const secondsUntilEnd: number = 500;

  // Market params: buy
  let listingId: BigNumber;
  const amountToBuy = getAmountBounded(parseInt(tokensPerBuyer.toString()));

  before(async () => {
    // Get signers
    const signers: SignerWithAddress[] = await ethers.getSigners();
    [protocolProvider, protocolAdmin, creator, buyer, relayer] = signers;
  });

  beforeEach(async () => {
    // Get contracts
    const contracts: Contracts = await getContracts(protocolProvider, protocolAdmin);
    market = contracts.market;
    accessNft = contracts.accessNft;
    coin = contracts.coin;
    forwarder = contracts.forwarder;
    protocolControl = contracts.protocolControl;
    registry = contracts.registry;

    // Create access NFTs
    const MINTER_ROLE = await accessNft.MINTER_ROLE();
    await accessNft.connect(protocolAdmin).grantRole(MINTER_ROLE, creator.address);

    await sendGaslessTx(creator, forwarder, relayer, {
      from: creator.address,
      to: accessNft.address,
      data: accessNft.interface.encodeFunctionData("createAccessTokens", [
        creator.address,
        rewardURIs,
        accessURIs,
        rewardSupplies,
        emptyData,
      ]),
    });

    // Approve Market to transfer tokens
    await sendGaslessTx(creator, forwarder, relayer, {
      from: creator.address,
      to: accessNft.address,
      data: accessNft.interface.encodeFunctionData("setApprovalForAll", [market.address, true]),
    });

    // Get listing ID
    listingId = await market.totalListings();

    // List tokens
    await sendGaslessTx(creator, forwarder, relayer, {
      from: creator.address,
      to: market.address,
      data: market.interface.encodeFunctionData("list", [
        accessNft.address,
        rewardId,
        coin.address,
        price,
        amountOfTokenToList,
        tokensPerBuyer,
        secondsUntilStart,
        secondsUntilEnd,
      ]),
    });

    // Set 5% royalty on Access NFT
    await accessNft.connect(protocolAdmin).setRoyaltyBps(500);
    // Set 5% market fee
    await market.connect(protocolAdmin).setMarketFeeBps(500);
  });

  describe("Revert cases", function () {
    it("Should revert if an invalid quantity of tokens is bought", async () => {
      const invalidQuantity: number = 0;

      await expect(
        sendGaslessTx(buyer, forwarder, relayer, {
          from: buyer.address,
          to: market.address,
          data: market.interface.encodeFunctionData("buy", [listingId, invalidQuantity]),
        }),
      ).to.be.revertedWith("Market: must buy an appropriate amount of tokens.");
    });

    it("Should revert if the sale window is closed", async () => {
      for (let i = 0; i < secondsUntilEnd; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await expect(
        sendGaslessTx(buyer, forwarder, relayer, {
          from: buyer.address,
          to: market.address,
          data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
        }),
      ).to.be.revertedWith("Market: the sale has either not started or closed.");
    });

    it("Should revert if the buyer tries to buy more than the buy limit", async () => {
      await expect(
        sendGaslessTx(buyer, forwarder, relayer, {
          from: buyer.address,
          to: market.address,
          data: market.interface.encodeFunctionData("buy", [listingId, tokensPerBuyer.add(1)]),
        }),
      ).to.be.revertedWith("Market: Cannot buy more from listing than permitted.");
    });

    it("Should revert if buyer hasn't allowed Market to transfer price amount of currency", async () => {
      await expect(
        sendGaslessTx(buyer, forwarder, relayer, {
          from: buyer.address,
          to: market.address,
          data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
        }),
      ).to.be.reverted;
    });
  });

  describe("Event", function () {
    beforeEach(async () => {
      // Mint currency to buyer
      await coin.connect(protocolAdmin).mint(buyer.address, price.mul(amountToBuy));

      // Approve Market to move currency
      await coin.connect(buyer).approve(market.address, price.mul(amountToBuy));
    });

    it("Should emit NewSale", async () => {
      const eventPromise = new Promise((resolve, reject) => {
        market.on("NewSale", (_assetContract, _seller, _listingId, _buyer, _quantity, _listing) => {
          expect(_assetContract).to.equal(accessNft.address);
          expect(_seller).to.equal(creator.address);
          expect(_listingId).to.equal(listingId);
          expect(_buyer).to.equal(buyer.address);
          expect(_quantity).to.equal(amountToBuy);

          expect(_listing.quantity).to.equal(amountOfTokenToList.sub(amountToBuy));

          resolve(null);
        });

        setTimeout(() => {
          reject(new Error("Timeout NewSale"));
        }, 5000);
      });

      await sendGaslessTx(buyer, forwarder, relayer, {
        from: buyer.address,
        to: market.address,
        data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
      });

      try {
        await eventPromise;
      } catch (e) {
        console.error(e);
      }
    });
  });

  describe("Balances", function () {
    beforeEach(async () => {
      // Mint currency to buyer
      await coin.connect(protocolAdmin).mint(buyer.address, price.mul(amountToBuy));

      // Approve Market to move currency
      await coin.connect(buyer).approve(market.address, price.mul(amountToBuy));
    });

    it("Should transfer all tokens bought to the buyer", async () => {
      const marketBalBefore: BigNumber = await accessNft.balanceOf(market.address, rewardId);

      await sendGaslessTx(buyer, forwarder, relayer, {
        from: buyer.address,
        to: market.address,
        data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
      });

      const marketBalAfter: BigNumber = await accessNft.balanceOf(market.address, rewardId);
      expect(await accessNft.balanceOf(buyer.address, rewardId)).to.equal(amountToBuy);
      expect(marketBalBefore.sub(marketBalAfter)).to.equal(amountToBuy);
    });

    it("Should distribute the right sale value to various stakeholders", async () => {
      // Get various fees
      const tokenRoyaltyBps: BigNumber = await accessNft.royaltyBps();
      const marketFeeBps: BigNumber = await market.marketFeeBps();
      const MAX_BPS = await protocolControl.MAX_BPS();

      // Get stakeholder shares
      const totalPrice: BigNumber = price.mul(amountToBuy);

      const marketCutBeforeProvider = totalPrice.mul(marketFeeBps).div(MAX_BPS); // Market cut goes to protocol control treasury.
      const royaltyAmountBeforeProvider: BigNumber = totalPrice.mul(tokenRoyaltyBps).div(MAX_BPS); // Creator shares - gets royalty too
      const totalRoyaltyTreasuryCut: BigNumber = marketCutBeforeProvider.add(royaltyAmountBeforeProvider); // Provider cut

      // Get balances before
      const buyerBalBefore: BigNumber = await coin.balanceOf(buyer.address);
      const treasuryBalBefore: BigNumber = await coin.balanceOf(
        await protocolControl.getRoyaltyTreasury(market.address),
      );

      await sendGaslessTx(buyer, forwarder, relayer, {
        from: buyer.address,
        to: market.address,
        data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
      });

      // Get balances after
      const buyerBalAfter: BigNumber = await coin.balanceOf(buyer.address);
      const treasuryBalAfter: BigNumber = await coin.balanceOf(
        await protocolControl.getRoyaltyTreasury(market.address),
      );

      expect(treasuryBalAfter.sub(treasuryBalBefore)).to.equal(totalRoyaltyTreasuryCut);
      expect(buyerBalBefore.sub(buyerBalAfter)).to.equal(totalPrice);
    });
  });

  describe("Contract state", function () {
    beforeEach(async () => {
      // Mint currency to buyer
      await coin.connect(protocolAdmin).mint(buyer.address, price.mul(amountToBuy));

      // Approve Market to move currency
      await coin.connect(buyer).approve(market.address, price.mul(amountToBuy));

      // Buy token
      await sendGaslessTx(buyer, forwarder, relayer, {
        from: buyer.address,
        to: market.address,
        data: market.interface.encodeFunctionData("buy", [listingId, amountToBuy]),
      });
    });

    it("Should update the listing quantity", async () => {
      const listing = await market.listings(listingId);
      expect(listing.quantity).to.equal(amountOfTokenToList.sub(amountToBuy));
    });

    it("Should update boughtFromListing for the buyer", async () => {
      const alreadyBought = await market.boughtFromListing(listingId, buyer.address);
      expect(alreadyBought).to.equal(amountToBuy);
    });
  });
});
