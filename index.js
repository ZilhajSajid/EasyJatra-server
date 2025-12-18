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
      // console.log(session);
      if (session.status === "complete") {
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
        };
        console.log(orderInfo);
      }
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
