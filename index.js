const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 4000;

const admin = require("firebase-admin");

const serviceAccount = require("./easyjatra-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bmwxjo0.mongodb.net/?appName=Cluster0`;

// mongo client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("easy-jatra-db");
    const ticketsCollection = db.collection("tickets");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");

    // tickets related APIs
    app.get("/tickets", async (req, res) => {
      const result = await ticketsCollection.find().toArray();
      res.send(result);
    });

    app.get("/tickets/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ticketsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.post("/tickets", async (req, res) => {
      const ticket = req.body;
      console.log(ticket);
      const result = await ticketsCollection.insertOne(ticket);
      res.send(result);
    });

    // payment related APIs
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      // console.log("payment information", paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                images: [paymentInfo?.image],
                description: paymentInfo?.description,
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          ticketId: paymentInfo?.ticketId,
          customer: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/ticket/${paymentInfo?.ticketId}`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const ticket = await ticketsCollection.findOne({
        _id: new ObjectId(session.metadata.ticketId),
      });
      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });
      // console.log(session);
      if (session.status === "complete" && ticket && !order) {
        // save order in db
        const orderInfo = {
          ticketId: session.metadata.ticketId,
          transactionId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          vendor: ticket.vendor,
          name: ticket.name,
          category: ticket.category,
          quantity: 1,
          price: session.amount_total / 100,
          image: ticket?.image,
        };
        // console.log(orderInfo);
        const result = await ordersCollection.insertOne(orderInfo);
        // update ticket quantity
        await ticketsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.ticketId),
          },
          { $inc: { quantity: -1 } }
        );
        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send(
        res.send({ transactionId: session.payment_intent, orderId: order._id })
      );
    });

    // get all orders for a customer by email
    app.get("/my-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection.find({ customer: email }).toArray();
      res.send(result);
    });

    // get all orders for vendors by email
    app.get("/vendor-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({ "vendor.email": email })
        .toArray();
      res.send(result);
    });

    // get all tickets for vendors by email
    app.get("/my-inventory/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ticketsCollection
        .find({ "vendor.email": email })
        .toArray();
      res.send(result);
    });

    // get all orders for a seller by email
    app.get("/manage-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({ "vendor.email": email })
        .toArray();
      res.send(result);
    });

    // users related APIs
    app.post("/user", async (req, res) => {
      const userData = req.body;
      // console.log(userData);
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";
      const query = {
        email: userData.email,
      };
      const alreadyExist = await usersCollection.findOne({
        email: userData.email,
      });
      console.log("user already here", !!alreadyExist);
      if (alreadyExist) {
        console.log("updating user info");
        const result = await usersCollection.updateOne(query, {
          $set: { last_loggedIn: new Date().toISOString() },
        });
        return res.send(result);
      }

      console.log("saving new user info");

      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("EasyJatra server is running!");
});

app.listen(port, () => {
  console.log(`EasyJatra app is running on port ${port}`);
});
