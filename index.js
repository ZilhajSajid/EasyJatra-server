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

app.use(
  cors({
    origin: [process.env.CLIENT_URL],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bmwxjo0.mongodb.net/?appName=Cluster0`;

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

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
    const vendorRequestCollection = db.collection("vendorRequests");

    // role middlewares
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user || user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only actions!", role: user?.role });

      next();
    };
    const verifyVendor = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user || user?.role !== "vendor")
        return res
          .status(403)
          .send({ message: "Vendor only actions!", role: user?.role });

      next();
    };

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

    app.post("/tickets", verifyJWT, verifyVendor, async (req, res) => {
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
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // vendor APIs
    // be a vendor req
    app.post("/become-vendor", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExist = await vendorRequestCollection.findOne({ email });
      if (alreadyExist)
        return res
          .status(409)
          .send({ message: "Your request is processing. Please Wait!" });
      const result = await vendorRequestCollection.insertOne({ email });
      res.send(result);
    });

    // get vendor request for admin
    app.get("/vendor-request", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await vendorRequestCollection.find().toArray();
      res.send(result);
    });

    // get all users for admin
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // update a users role
    app.patch("/update-role", verifyJWT, verifyAdmin, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await vendorRequestCollection.deleteOne({ email });
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
    app.get(
      "/my-inventory/:email",
      verifyJWT,
      verifyVendor,
      async (req, res) => {
        const email = req.params.email;
        const result = await ticketsCollection
          .find({ "vendor.email": email })
          .toArray();
        res.send(result);
      }
    );

    // get all orders for a vendor by email
    app.get(
      "/manage-orders/:email",
      verifyJWT,
      verifyVendor,
      async (req, res) => {
        const email = req.params.email;
        const result = await ordersCollection
          .find({ "vendor.email": email })
          .toArray();
        res.send(result);
      }
    );

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

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
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
